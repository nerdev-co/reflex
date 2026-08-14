import { Hono } from "hono";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { getCookie } from "hono/cookie";
import { prisma } from "../lib/prisma.js";
import { errors } from "../lib/errors.js";
import { getUserBySession, SESSION_COOKIE } from "../lib/auth.js";
import { actions, triggers } from "@repo/integrations";
import { interpolateConfig } from "@repo/core";
import { toJson } from "../lib/json.js";
import type { AppContext } from "../lib/context.js";

export const workflowRoutes = new Hono();

async function requireUser(c: AppContext) {
  const user = await getUserBySession(getCookie(c, SESSION_COOKIE));
  if (!user) throw errors.unauthorized();
  return user;
}

const stepSchema = z.object({
  actionKey: z.string(),
  config: z.record(z.unknown()).default({}),
});

const workflowSchema = z.object({
  name: z.string().min(1).max(100),
  trigger: z.object({
    key: z.string(),
    config: z.record(z.unknown()).default({}),
  }),
  steps: z.array(stepSchema).min(1).max(10),
});

workflowRoutes.get("/", async (c: AppContext) => {
  const user = await requireUser(c);
  const workflows = await prisma.workflow.findMany({
    where: { userId: user.id },
    include: { _count: { select: { runs: true } } },
    orderBy: { createdAt: "desc" },
  });
  return c.json({ workflows: workflows.map(({ _count, ...w }) => ({ ...w, runCount: _count.runs })) });
});

workflowRoutes.get("/:id", async (c: AppContext) => {
  const user = await requireUser(c);
  const workflow = await prisma.workflow.findFirst({
    where: { id: c.req.param("id"), userId: user.id },
    include: { steps: { orderBy: { position: "asc" } } },
  });
  if (!workflow) throw errors.notFound("Workflow not found");
  return c.json({ workflow });
});

workflowRoutes.post("/", async (c: AppContext) => {
  const user = await requireUser(c);
  const parsed = workflowSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw errors.badRequest("Invalid workflow definition");
  const { name, trigger, steps } = parsed.data;

  if (!triggers[trigger.key]) throw errors.badRequest(`Unknown trigger: ${trigger.key}`);
  for (const step of steps) {
    if (!actions[step.actionKey]) throw errors.badRequest(`Unknown action: ${step.actionKey}`);
  }

  const workflow = await prisma.$transaction(async (tx) => {
    const wf = await tx.workflow.create({
      data: { userId: user.id, name, triggerKey: trigger.key, triggerConfig: toJson(trigger.config), version: 1 },
    });
    for (const [i, step] of steps.entries()) {
      await tx.step.create({
        data: { workflowId: wf.id, position: i + 1, actionKey: step.actionKey, config: toJson(step.config) },
      });
    }
    await tx.workflowVersion.create({
      data: {
        workflowId: wf.id,
        version: 1,
        definition: {
          trigger: toJson(trigger),
          steps: steps.map((s, i) => ({ position: i + 1, actionKey: s.actionKey, config: s.config })) as never,
        },
      },
    });
    return wf;
  });

  return c.json({ workflow }, 201);
});

workflowRoutes.patch("/:id", async (c: AppContext) => {
  const user = await requireUser(c);
  const existing = await prisma.workflow.findFirst({ where: { id: c.req.param("id"), userId: user.id } });
  if (!existing) throw errors.notFound("Workflow not found");

  const parsed = workflowSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw errors.badRequest("Invalid workflow update");
  const { name, trigger, steps } = parsed.data;

  const nextVersion = existing.version + 1;
  const workflow = await prisma.$transaction(async (tx) => {
    const wf = await tx.workflow.update({
      where: { id: existing.id },
      data: {
        ...(name ? { name } : {}),
        ...(trigger ? { triggerKey: trigger.key, triggerConfig: toJson(trigger.config) } : {}),
        version: nextVersion,
      },
    });
    if (steps) {
      await tx.step.deleteMany({ where: { workflowId: existing.id } });
      for (const [i, step] of steps.entries()) {
        await tx.step.create({
          data: { workflowId: existing.id, position: i + 1, actionKey: step.actionKey, config: toJson(step.config) },
        });
      }
    }
    const stepsSnapshot = await tx.step.findMany({ where: { workflowId: existing.id }, orderBy: { position: "asc" } });
    await tx.workflowVersion.create({
      data: {
        workflowId: existing.id,
        version: nextVersion,
        definition: {
          trigger: { key: wf.triggerKey, config: wf.triggerConfig },
          steps: stepsSnapshot.map((s) => ({ position: s.position, actionKey: s.actionKey, config: s.config })),
        },
      },
    });
    return wf;
  });

  return c.json({ workflow });
});

workflowRoutes.delete("/:id", async (c: AppContext) => {
  const user = await requireUser(c);
  const existing = await prisma.workflow.findFirst({ where: { id: c.req.param("id"), userId: user.id } });
  if (!existing) throw errors.notFound("Workflow not found");
  // Runs are immutable history — they survive the workflow (FK is SetNull).
  await prisma.workflow.delete({ where: { id: existing.id } });
  return c.json({ ok: true });
});

workflowRoutes.post("/:id/enable", async (c: AppContext) => {
  const user = await requireUser(c);
  const wf = await prisma.workflow.findFirst({ where: { id: c.req.param("id"), userId: user.id } });
  if (!wf) throw errors.notFound("Workflow not found");

  let webhookPath = wf.webhookPath;
  let webhookSecret = wf.webhookSecret;
  if (!webhookPath || !webhookSecret) {
    webhookPath = `wh_${randomBytes(16).toString("hex")}`;
    webhookSecret = randomBytes(32).toString("hex");
  }

  await prisma.workflow.update({
    where: { id: wf.id },
    data: { status: "ENABLED", webhookPath, webhookSecret },
  });

  const webhookUrl = `http://localhost:${process.env.PORT ?? 3001}/hooks/${webhookPath}`;
  return c.json({ workflow: { ...wf, status: "ENABLED" }, webhookPath, webhookSecret, webhookUrl });
});

workflowRoutes.post("/:id/disable", async (c: AppContext) => {
  const user = await requireUser(c);
  const wf = await prisma.workflow.findFirst({ where: { id: c.req.param("id"), userId: user.id } });
  if (!wf) throw errors.notFound("Workflow not found");
  await prisma.workflow.update({ where: { id: wf.id }, data: { status: "DISABLED" } });
  return c.json({ ok: true });
});

// Dry run (docs/06): resolve against the trigger's sample, interpolate,
// call perform with dryRun:true — never touch real APIs.
workflowRoutes.post("/:id/test", async (c: AppContext) => {
  const user = await requireUser(c);
  const wf = await prisma.workflow.findFirst({
    where: { id: c.req.param("id"), userId: user.id },
    include: { steps: { orderBy: { position: "asc" } } },
  });
  if (!wf) throw errors.notFound("Workflow not found");

  const triggerDef = triggers[wf.triggerKey];
  if (!triggerDef) throw errors.badRequest(`Unknown trigger: ${wf.triggerKey}`);

  const samplePayload = triggerDef.operation.sample;
  const stepOutputs: Record<number, { output?: unknown }> = {};

  const results = [];
  for (const step of wf.steps) {
    const actionDef = actions[step.actionKey];
    if (!actionDef) throw errors.badRequest(`Unknown action: ${step.actionKey}`);
    const resolvedInput = interpolateConfig(step.config, { trigger: samplePayload, steps: stepOutputs });
    const output = await actionDef.operation.perform({
      payload: resolvedInput,
      config: resolvedInput as Record<string, unknown>,
      auth: {},
      dryRun: true,
    });
    stepOutputs[step.position] = { output };    results.push({ position: step.position, actionKey: step.actionKey, input: resolvedInput, predictedOutput: output });
  }

  return c.json({ workflowId: wf.id, trigger: { key: wf.triggerKey, samplePayload }, results });
});