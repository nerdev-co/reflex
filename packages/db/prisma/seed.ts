// Reflex seed — run with `bun run db:seed` from packages/db.
// Idempotent: safe to re-run.
//
// Seeds:
//   1. Registry: AvailableTrigger / AvailableAction (drives the builder UI)
//   2. Demo user + workflows with steps
//   3. One FAILED run with full trace (attempts, events) so the trace UI
//      has something to render on day one
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient();

async function seedRegistry() {
  await prisma.availableTrigger.upsert({
    where: { key: "webhook" },
    update: {},
    create: {
      key: "webhook",
      noun: "Webhook",
      type: "WEBHOOK",
      metadata: {
        inputFields: [
          { key: "method", type: "string", default: "POST", helpText: "HTTP method the webhook responds to" },
        ],
        sample: { id: "evt_1", event: "issue.opened", payload: { title: "Example issue" } },
        helpText: "Fires when a third party POSTs to your generated webhook URL.",
      },
    },
  });

  await prisma.availableTrigger.upsert({
    where: { key: "schedule" },
    update: {},
    create: {
      key: "schedule",
      noun: "Schedule",
      type: "SCHEDULE",
      metadata: {
        inputFields: [
          { key: "cron", type: "string", required: true, helpText: "Cron expression, e.g. 0 9 * * *" },
        ],
        sample: { firedAt: "2026-08-14T09:00:00Z" },
        helpText: "Fires on a cron schedule.",
      },
    },
  });

  await prisma.availableTrigger.upsert({
    where: { key: "form" },
    update: {},
    create: {
      key: "form",
      noun: "Form submit",
      type: "WEBHOOK",
      metadata: {
        inputFields: [
          { key: "fields", type: "string", helpText: "Comma-separated field names the form collects" },
        ],
        sample: { id: "sub_1", fields: { name: "Ada", email: "ada@example.com" } },
        helpText: "Fires when someone submits a form to your generated URL.",
      },
    },
  });

  await prisma.availableAction.upsert({
    where: { key: "http.request" },
    update: {},
    create: {
      key: "http.request",
      noun: "HTTP Request",
      idempotentSafe: true,
      metadata: {
        inputFields: [
          { key: "method", type: "string", default: "GET", required: true },
          { key: "url", type: "string", required: true },
          { key: "headers", type: "string", helpText: "JSON object of headers" },
          { key: "body", type: "text", helpText: "Request body — templates supported" },
        ],
        sample: { status: 200, body: { ok: true } },
        helpText: "Send an HTTP request to any URL.",
      },
    },
  });

  for (const [key, noun, idempotentSafe] of [
    ["slack.sendMessage", "Slack Message", false],
    ["discord.sendMessage", "Discord Message", false],
    ["email.send", "Email", false],
  ] as const) {
    await prisma.availableAction.upsert({
      where: { key },
      update: {},
      create: {
        key,
        noun,
        idempotentSafe,
        metadata: {
          inputFields: [
            { key: "channel", type: "string", required: true, helpText: "Channel or target" },
            { key: "text", type: "text", required: true, helpText: "Message body — templates supported" },
          ],
          sample: { ok: true, id: "msg_1" },
          helpText: `Send a message via ${noun}.`,
        },
      },
    });
  }
}

async function seedDemoData() {
  const passwordHash = await Bun.password.hash("demo123", { algorithm: "argon2id" });

  const user = await prisma.user.upsert({
    where: { email: "demo@reflex.dev" },
    update: {},
    create: { email: "demo@reflex.dev", passwordHash },
  });

  // Workflow 1: webhook → parse → slack → email (enabled, has run history)
  const wf1 = await prisma.workflow.upsert({
    where: { id: "wf_demo_github" },
    update: {},
    create: {
      id: "wf_demo_github",
      userId: user.id,
      name: "Slack on new GitHub issue",
      triggerKey: "webhook",
      triggerConfig: { method: "POST" },
      status: "ENABLED",
      version: 1,
      webhookPath: "wh_demo_github",
      webhookSecret: "demo-secret-do-not-use-in-prod",
    },
  });

  await prisma.workflowVersion.upsert({
    where: { workflowId_version: { workflowId: wf1.id, version: 1 } },
    update: {},
    create: {
      workflowId: wf1.id,
      version: 1,
      definition: {
        trigger: { key: "webhook", config: { method: "POST" } },
        steps: [
          { position: 1, actionKey: "http.request", config: { method: "GET", url: "https://example.com/issues" } },
          { position: 2, actionKey: "slack.sendMessage", config: { channel: "#alerts", text: "New issue #{{trigger.payload.issue.number}}: {{trigger.payload.issue.title}}" } },
          { position: 3, actionKey: "email.send", config: { channel: "me@example.com", text: "Issue opened: {{trigger.payload.issue.title}}" } },
        ],
      },
    },
  });

  const step1 = await prisma.step.upsert({
    where: { workflowId_position: { workflowId: wf1.id, position: 1 } },
    update: {},
    create: {
      workflowId: wf1.id,
      position: 1,
      actionKey: "http.request",
      config: { method: "GET", url: "https://example.com/issues" },
    },
  });
  const step2 = await prisma.step.upsert({
    where: { workflowId_position: { workflowId: wf1.id, position: 2 } },
    update: {},
    create: {
      workflowId: wf1.id,
      position: 2,
      actionKey: "slack.sendMessage",
      config: { channel: "#alerts", text: "New issue #{{trigger.payload.issue.number}}: {{trigger.payload.issue.title}}" },
    },
  });
  const step3 = await prisma.step.upsert({
    where: { workflowId_position: { workflowId: wf1.id, position: 3 } },
    update: {},
    create: {
      workflowId: wf1.id,
      position: 3,
      actionKey: "email.send",
      config: { channel: "me@example.com", text: "Issue opened: {{trigger.payload.issue.title}}" },
    },
  });

  // Workflow 2: daily digest (enabled, no runs yet)
  const wf2 = await prisma.workflow.upsert({
    where: { id: "wf_demo_digest" },
    update: {},
    create: {
      id: "wf_demo_digest",
      userId: user.id,
      name: "Daily digest",
      triggerKey: "schedule",
      triggerConfig: { cron: "0 9 * * *" },
      status: "ENABLED",
      version: 1,
    },
  });
  await prisma.step.upsert({
    where: { workflowId_position: { workflowId: wf2.id, position: 1 } },
    update: {},
    create: {
      workflowId: wf2.id,
      position: 1,
      actionKey: "http.request",
      config: { method: "GET", url: "https://example.com/digest" },
    },
  });

  // Run history for wf1: one FAILED run with a full trace, one SUCCEEDED run.
  const existingRuns = await prisma.zapRun.count({ where: { workflowId: wf1.id } });
  if (existingRuns > 0) return;

  const payload = {
    action: "opened",
    issue: { number: 12, title: "Bun 1.3 crashes on ARM" },
    repository: { full_name: "example/repo" },
  };

  const failedRun = await prisma.zapRun.create({
    data: {
      id: "run_demo_failed",
      workflowId: wf1.id,
      workflowVersion: 1,
      triggerKey: "webhook",
      triggerPayload: payload,
      status: "FAILED",
      startedAt: new Date(Date.now() - 90_000),
      finishedAt: new Date(Date.now() - 60_000),
    },
  });

  const sr1 = await prisma.stepRun.create({
    data: {
      runId: failedRun.id,
      stepId: step1.id,
      stepKey: "http.request",
      config: step1.config,
      status: "SUCCEEDED",
      attemptCount: 1,
      output: { status: 200, body: { issues: [{ id: 12, title: "Bun 1.3 crashes on ARM" }] } },
      enqueuedAt: new Date(Date.now() - 89_000),
      claimedAt: new Date(Date.now() - 88_000),
      startedAt: new Date(Date.now() - 88_000),
      finishedAt: new Date(Date.now() - 87_500),
    },
  });
  await prisma.stepRunAttempt.create({
    data: {
      stepRunId: sr1.id,
      attemptNo: 1,
      input: { method: "GET", url: "https://example.com/issues" },
      output: { status: 200, body: { issues: [{ id: 12 }] } },
      durationMs: 500,
    },
  });

  const sr2 = await prisma.stepRun.create({
    data: {
      runId: failedRun.id,
      stepId: step2.id,
      stepKey: "slack.sendMessage",
      config: step2.config,
      status: "SUCCEEDED",
      attemptCount: 1,
      output: { ok: true, ts: "1700000000.000001" },
      enqueuedAt: new Date(Date.now() - 87_000),
      claimedAt: new Date(Date.now() - 86_000),
      startedAt: new Date(Date.now() - 86_000),
      finishedAt: new Date(Date.now() - 85_000),
    },
  });
  await prisma.stepRunAttempt.create({
    data: {
      stepRunId: sr2.id,
      attemptNo: 1,
      input: { channel: "#alerts", text: "New issue #12: Bun 1.3 crashes on ARM" },
      output: { ok: true, ts: "1700000000.000001" },
      durationMs: 1_000,
    },
  });

  const sr3 = await prisma.stepRun.create({
    data: {
      runId: failedRun.id,
      stepId: step3.id,
      stepKey: "email.send",
      config: step3.config,
      status: "FAILED",
      attemptCount: 2,
      enqueuedAt: new Date(Date.now() - 84_000),
      claimedAt: new Date(Date.now() - 83_000),
      startedAt: new Date(Date.now() - 83_000),
      nextAttemptAt: new Date(Date.now() - 61_000),
      finishedAt: new Date(Date.now() - 60_000),
    },
  });
  await prisma.stepRunAttempt.create({
    data: {
      stepRunId: sr3.id,
      attemptNo: 1,
      input: { channel: "me@example.com", text: "Issue opened: Bun 1.3 crashes on ARM" },
      output: null,
      error: { class: "TimeoutError", message: "Request timed out after 30s", httpStatus: 504 },
      httpTrace: { request: { url: "smtp://smtp.example.com", headers: {} }, response: null },
      durationMs: 30_000,
    },
  });
  await prisma.stepRunAttempt.create({
    data: {
      stepRunId: sr3.id,
      attemptNo: 2,
      input: { channel: "me@example.com", text: "Issue opened: Bun 1.3 crashes on ARM" },
      output: null,
      error: { class: "AuthError", message: "SMTP credentials rejected", httpStatus: 401 },
      httpTrace: { request: { url: "smtp://smtp.example.com", headers: {} }, response: { status: 401, body: "authentication failed" } },
      durationMs: 2_500,
    },
  });

  await prisma.runEvent.createMany({
    data: [
      { runId: failedRun.id, type: "step_claimed", data: { step: 1 }, at: new Date(Date.now() - 88_000) },
      { runId: failedRun.id, type: "step_succeeded", data: { step: 1 }, at: new Date(Date.now() - 87_500) },
      { runId: failedRun.id, type: "step_claimed", data: { step: 2 }, at: new Date(Date.now() - 86_000) },
      { runId: failedRun.id, type: "step_succeeded", data: { step: 2 }, at: new Date(Date.now() - 85_000) },
      { runId: failedRun.id, type: "step_claimed", data: { step: 3 }, at: new Date(Date.now() - 83_000) },
      { runId: failedRun.id, type: "attempt_recorded", data: { step: 3, attemptNo: 1 }, at: new Date(Date.now() - 82_000) },
      { runId: failedRun.id, type: "retry_scheduled", data: { step: 3, attemptNo: 1, delayMs: 2_000 }, at: new Date(Date.now() - 82_000) },
      { runId: failedRun.id, type: "step_claimed", data: { step: 3, attemptNo: 2 }, at: new Date(Date.now() - 79_000) },
      { runId: failedRun.id, type: "attempt_recorded", data: { step: 3, attemptNo: 2 }, at: new Date(Date.now() - 60_000) },
      { runId: failedRun.id, type: "step_failed", data: { step: 3 }, at: new Date(Date.now() - 60_000) },
    ],
  });

  const okRun = await prisma.zapRun.create({
    data: {
      id: "run_demo_succeeded",
      workflowId: wf1.id,
      workflowVersion: 1,
      triggerKey: "webhook",
      triggerPayload: { action: "opened", issue: { number: 11, title: "Login redirect broken" }, repository: { full_name: "example/repo" } },
      status: "SUCCEEDED",
      startedAt: new Date(Date.now() - 3_600_000),
      finishedAt: new Date(Date.now() - 3_599_000),
    },
  });
  for (const [i, step, status, output] of [
    [1, step1, "SUCCEEDED", { status: 200, body: {} }],
    [2, step2, "SUCCEEDED", { ok: true }],
    [3, step3, "SUCCEEDED", { ok: true }],
  ] as const) {
    const sr = await prisma.stepRun.create({
      data: {
        runId: okRun.id,
        stepId: step.id,
        stepKey: step.actionKey,
        config: step.config,
        status,
        attemptCount: 1,
        output,
        enqueuedAt: new Date(Date.now() - 3_600_000 + i * 100),
        claimedAt: new Date(Date.now() - 3_600_000 + i * 100),
        startedAt: new Date(Date.now() - 3_600_000 + i * 100),
        finishedAt: new Date(Date.now() - 3_600_000 + i * 100 + 50),
      },
    });
    await prisma.stepRunAttempt.create({
      data: {
        stepRunId: sr.id,
        attemptNo: 1,
        input: step.config,
        output,
        durationMs: 50,
      },
    });
  }
}

async function main() {
  await seedRegistry();
  await seedDemoData();
  console.log("Seed complete ✔  (demo login: demo@reflex.dev / demo123)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
