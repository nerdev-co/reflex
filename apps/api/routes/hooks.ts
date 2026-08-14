// Public webhook receiver (docs/06): authenticated by HMAC signature over the
// raw body, not by session. Sign the raw body string, never parsed JSON.
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { errors } from "../lib/errors.js";
import { queue } from "../lib/queue.js";
import { toJson } from "../lib/json.js";
import type { AppContext } from "../lib/context.js";

export const hookRoutes = new Hono();

function verifySignature(rawBody: string, secret: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signature.replace(/^sha256=/, "");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
}

hookRoutes.get("/:path", async (c: AppContext) => {
  const workflow = await prisma.workflow.findUnique({ where: { webhookPath: c.req.param("path") } });
  if (!workflow) throw errors.notFound("Unknown webhook");
  return c.text("ok");
});

hookRoutes.post("/:path", async (c: AppContext) => {
  const workflow = await prisma.workflow.findUnique({ where: { webhookPath: c.req.param("path") } });
  if (!workflow) throw errors.notFound("Unknown webhook");
  if (workflow.status !== "ENABLED") throw errors.forbidden("Workflow is not enabled");

  const rawBody = await c.req.text();
  if (!verifySignature(rawBody, workflow.webhookSecret!, c.req.header("x-reflex-signature"))) {
    throw errors.unauthorized("Invalid signature");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = rawBody;
  }

  // Create the run + step rows BEFORE enqueueing — the trace is truthful from t0.
  const version = await prisma.workflowVersion.findUnique({
    where: { workflowId_version: { workflowId: workflow.id, version: workflow.version } },
  });
  const definition = (version?.definition ?? { steps: [] }) as {
    steps?: { position: number; actionKey: string; config: Record<string, unknown> }[];
  };

  const run = await prisma.zapRun.create({
    data: {
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      triggerKey: workflow.triggerKey,
      triggerPayload: toJson(payload),
      status: "PENDING",
    },
  });

  for (const step of definition.steps ?? []) {
    const stepRun = await prisma.stepRun.create({
      data: { runId: run.id, stepKey: step.actionKey, config: toJson(step.config), status: "QUEUED" },
    });
    queue.enqueue({ runId: run.id, stepId: stepRun.id });
  }

  await prisma.runEvent.create({ data: { runId: run.id, type: "run_created", data: {} } });

  return c.json({ ok: true, runId: run.id }, 201);
});