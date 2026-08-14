import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { prisma } from "../lib/prisma.js";
import { errors } from "../lib/errors.js";
import { getUserBySession, SESSION_COOKIE } from "../lib/auth.js";
import { queue } from "../lib/queue.js";
import { toJson } from "../lib/json.js";
import type { AppContext } from "../lib/context.js";

export const runRoutes = new Hono();

async function requireUser(c: AppContext) {
  const user = await getUserBySession(getCookie(c, SESSION_COOKIE));
  if (!user) throw errors.unauthorized();
  return user;
}

async function findRun(c: AppContext, runId: string | undefined, userId: string) {
  if (!runId) throw errors.notFound("Run not found");
  const run = await prisma.zapRun.findFirst({ where: { id: runId, workflow: { userId } } });
  if (!run) throw errors.notFound("Run not found");
  return run;
}

// The trace contract (docs/05) — one JSON tree the UI renders from.
runRoutes.get("/", async (c: AppContext) => {
  const user = await requireUser(c);
  const workflowId = c.req.query("workflow");
  const status = c.req.query("status");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const pageSize = 25;

  const where = { workflow: { userId: user.id }, ...(workflowId ? { workflowId } : {}), ...(status ? { status: status as any } : {}) };

  const [runs, total] = await Promise.all([
    prisma.zapRun.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { workflow: { select: { name: true } } },
    }),
    prisma.zapRun.count({ where }),
  ]);

  return c.json({
    runs: runs.map(({ workflow, ...run }) => ({ ...run, workflowName: workflow?.name ?? null })),
    page,
    pageSize,
    total,
  });
});

runRoutes.get("/:id", async (c: AppContext) => {
  const user = await requireUser(c);
  const run = await prisma.zapRun.findFirst({
    where: { id: c.req.param("id"), workflow: { userId: user.id } },
    include: {
      stepRuns: { orderBy: { enqueuedAt: "asc" }, include: { attempts: { orderBy: { attemptNo: "asc" } } } },
      events: { orderBy: { at: "asc" } },
    },
  });
  if (!run) throw errors.notFound("Run not found");
  return c.json({ run });
});

async function createRunWithSteps(params: {
  userId: string;
  workflowId: string;
  workflowVersion: number;
  triggerKey: string;
  triggerPayload: unknown;
  replayOfRunId?: string | null;
  supersedeOriginalRunId?: string | null;
  enqueue: boolean;
}) {
  const { userId, workflowId, workflowVersion, triggerKey, triggerPayload, replayOfRunId, supersedeOriginalRunId, enqueue } = params;

  const workflow = await prisma.workflow.findFirst({ where: { id: workflowId, userId } });
  if (!workflow) throw errors.notFound("Workflow not found");

  const version = await prisma.workflowVersion.findUnique({
    where: { workflowId_version: { workflowId, version: workflowVersion } },
  });
  if (!version) throw errors.badRequest(`Workflow version ${workflowVersion} not found`);

  const definition = version.definition as {
    steps?: { position: number; actionKey: string; config: Record<string, unknown> }[];
  };
  const steps = definition.steps ?? [];

  if (supersedeOriginalRunId) {
    // Replay cancels pending retries in the original run (ADR-06).
    await prisma.stepRun.updateMany({
      where: { runId: supersedeOriginalRunId, status: { in: ["RETRYING", "QUEUED"] } },
      data: { status: "SUPERSEDED" },
    });
  }

  const run = await prisma.zapRun.create({
    data: {
      workflowId,
      workflowVersion,
      triggerKey,
      triggerPayload: toJson(triggerPayload),
      status: "PENDING",
      ...(replayOfRunId ? { replayOfRunId } : {}),
    },
  });

  for (const step of steps) {
    const stepRun = await prisma.stepRun.create({
        data: { runId: run.id, stepKey: step.actionKey, config: toJson(step.config), status: "QUEUED", attemptCount: 0 },
    });
    if (enqueue) queue.enqueue({ runId: run.id, stepId: stepRun.id });
  }

  await prisma.runEvent.create({
    data: {
      runId: run.id,
      type: replayOfRunId ? "replay_created" : "run_created",
      data: replayOfRunId ? { of: replayOfRunId } : {},
    },
  });

  return run;
}

// Full replay — new run id, same payload, same version (docs/05).
runRoutes.post("/:id/replay", async (c: AppContext) => {
  const user = await requireUser(c);
  const original = await findRun(c, c.req.param("id"), user.id);
  if (original.replayOfRunId) throw errors.badRequest("Cannot replay a replay — use the original run");

  const run = await createRunWithSteps({
    userId: user.id,
    workflowId: original.workflowId!,
    workflowVersion: original.workflowVersion!,
    triggerKey: original.triggerKey,
    triggerPayload: original.triggerPayload,
    replayOfRunId: original.id,
    supersedeOriginalRunId: original.id,
    enqueue: true,
  });

  return c.json({ run }, 201);
});

// Replay from a step — completed steps are inherited (skipped), the failed
// step onward re-executes (ADR-06).
runRoutes.post("/:id/replay-from-step", async (c: AppContext) => {
  const user = await requireUser(c);
  const original = await findRun(c, c.req.param("id"), user.id);
  const body = await c.req.json().catch(() => null);
  const stepRunId = body?.stepId as string | undefined;
  if (!stepRunId) throw errors.badRequest("stepId is required");

  const originalStepRun = await prisma.stepRun.findFirst({ where: { id: stepRunId, runId: original.id } });
  if (!originalStepRun) throw errors.notFound("Step run not found in this run");

  const workflow = await prisma.workflow.findFirst({ where: { id: original.workflowId!, userId: user.id } });
  if (!workflow) throw errors.notFound("Workflow not found");

  const version = await prisma.workflowVersion.findUnique({
    where: { workflowId_version: { workflowId: workflow.id, version: original.workflowVersion! } },
  });
  if (!version) throw errors.badRequest("Workflow version not found");

  const definition = version.definition as { steps?: { position: number; actionKey: string; config: Record<string, unknown> }[] };
  const steps = definition.steps ?? [];

  const originalStepRuns = await prisma.stepRun.findMany({ where: { runId: original.id } });
  const targetPosition = steps.findIndex((s) => s.actionKey === originalStepRun.stepKey);
  const byPosition = new Map(originalStepRuns.map((sr) => [sr.stepKey, sr]));

  // Cancel pending retries in the original run.
  await prisma.stepRun.updateMany({
    where: { runId: original.id, status: { in: ["RETRYING", "QUEUED"] } },
    data: { status: "SUPERSEDED" },
  });

  const run = await prisma.zapRun.create({
    data: {
      workflowId: original.workflowId,
      workflowVersion: original.workflowVersion,
      triggerKey: original.triggerKey,
      triggerPayload: toJson(original.triggerPayload),
      status: "PENDING",
      replayOfRunId: original.id,
    },
  });

  for (const [i, step] of steps.entries()) {
    if (i < targetPosition) {
      // Inherit completed steps (skipped) with their recorded output.
      const originalSr = byPosition.get(step.actionKey);
      await prisma.stepRun.create({
        data: {
          runId: run.id,
          stepKey: step.actionKey,
          config: toJson(step.config),
          status: "SKIPPED",
          attemptCount: originalSr?.attemptCount ?? 0,
          output: originalSr?.output ? toJson(originalSr.output) : undefined,
          inheritedFromStepRunId: originalSr?.id,
        },
      });
    } else {
      const stepRun = await prisma.stepRun.create({
      data: { runId: run.id, stepKey: step.actionKey, config: toJson(step.config), status: "QUEUED", attemptCount: 0 },
      });
      queue.enqueue({ runId: run.id, stepId: stepRun.id });
    }
  }

  await prisma.runEvent.create({
    data: { runId: run.id, type: "replay_created", data: { of: original.id, fromStep: originalStepRun.stepKey } },
  });

  return c.json({ run }, 201);
});