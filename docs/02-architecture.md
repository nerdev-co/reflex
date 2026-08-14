# 02 — Architecture

## High-level system

```
                ┌──────────────────────────────────────────────┐
                │                   API layer                  │
                │  (workflow CRUD · run history · auth · OAuth)│
                └──────────────┬───────────────────────────────┘
                               │
   webhook ──► ┌───────────────▼───────────────┐
   schedule ──►│        Trigger service        │──► outbox ──► poller ──► ┌──────────────────────┐
   form    ──► │   (validate, enrich, dedupe)  │    (row)       │          │   Job queue (Redis)  │
               └───────────────────────────────┘                └─────────►│  (idempotency keys) │
                                                                           └──────────┬───────────┘
                                                               ▼
                                                     ┌──────────────────────┐
                                                     │     Workers          │
                                                     │  execute step DAGs,  │
                                                     │  retry w/ backoff    │
                                                     └──────────┬───────────┘
                                                               ▼
                                                     ┌──────────────────────┐
                                                     │  Run store (Postgres)│
                                                     │  (runs, traces,      │
                                                     │   payloads, events)  │
                                                     └──────────────────────┘
                                                               ▲
                                                     ┌─────────┴──────────┐
                                                     │      Reaper         │
                                                     │  (retries, stale    │
                                                     │   claims)           │
                                                     └─────────────────────┘
```

## The principle everything hangs on

> **The queue is a delivery mechanism. The DB is the source of truth.**

The queue (Redis/Kafka) can lose or duplicate messages — so a message is only a *suggestion* to process a step. Every decision happens in the DB with conditional writes; the queue just carries work. This single sentence makes the whole reliability design fall out (see [execution-engine](04-execution-engine.md)).

## Components

### API layer
Express-style REST server. User auth (email + password, sessions), workflow CRUD (version-bumping on edit), run history, replay endpoints, credentials management, and the registry endpoints that power the builder UI. See [api-and-auth](06-api-and-auth.md).

### Trigger service
Converts "an event happened" into "a run exists." Three trigger classes, implemented differently (below). The publish path is **transactional**: the run, its first step row, and an outbox row commit in ONE transaction via the shared `publishRun` seam (`packages/publish`) — every producer (webhook hook, scheduler, replay) uses it, and none of them ever touches the queue directly. A poller in the worker process forwards outbox rows to the queue and deletes them only after the enqueue lands (delete-after-ack; `enqueue` awaits its Redis writes so the ack is real), so a crash between commit and enqueue retries next tick. Jobs are `Job = { runId, stepId }` messages.

### Job queue
Distributed FIFO + delayed delivery (due-retry re-enqueue). At-least-once semantics are fine — the DB claim handles duplicates. In-process for dev, Redis for prod; Kafka swaps in behind the same seam.

### Workers
Stateless consumers running **four loops in one process**:
1. **Outbox poller** — forwards committed outbox rows to the queue (3s tick, batch 10, delete-after-ack, no overlapping ticks).
2. **Scheduler** — drives POLL/SCHEDULE workflows: asks the trigger definition for items, dedups each item id atomically via the `TriggerState(workflowId, itemId)` unique insert, and publishes the new ones through `publishRun` in the same transaction (a crash leaves nothing; a duplicate is impossible).
3. **Consume** — claim a step via conditional UPDATE, resolve the step's input (interpolation), look up the action definition from the registry, call its `perform`, record the attempt, chain the DAG or schedule a retry.
4. **Reaper** — due retries/waits and stale claims.
See [execution-engine](04-execution-engine.md).

### Credential vault
AES-GCM encryption at rest (`packages/credentials`). The API stores the encrypted blob and never decrypts; the worker decrypts at execution time and hands the plaintext to the action as `auth`. Secrets never appear in traces. See [api-and-auth](06-api-and-auth.md).

### Run store (Postgres)
`zap_runs`, `step_runs`, `step_run_attempts`, `run_events`, `zap_run_outbox`, plus the registry and credentials tables. See [data-model](03-data-model.md).

### Reaper
A lightweight cron (a few-second tick) with two jobs:
1. Re-enqueue `retrying` steps whose `next_attempt_at` has passed (the actual retry mechanism — workers never sleep).
2. Reclaim `running` steps whose `claimed_at` is stale (workers that were SIGKILLed mid-execution).

## Trigger classes — the engine implements each differently

### A. Polling triggers (engine-initiated)
Implemented — `schedule` (interval) and `http.poll` (fetch a URL for `{ items: [{ id, ... }] }`) ship in the registry.
- The worker's **scheduler loop** fires every ~2s per enabled POLL/SCHEDULE workflow.
- Engine calls the trigger definition's `perform` → a *list* of items.
- **Dedup IS the claim:** each item carries an `id`; `TriggerState(workflowId, itemId)` is unique, so the dedup INSERT either wins (publish the run in the same transaction) or hits P2002 (seen — skip). Safe under any number of scheduler instances, no locks.

### B. Incoming webhook triggers (GitHub, form submit)
- Engine *exposes* a URL: `https://reflex.app/hooks/wh_{uuid}` plus a per-webhook secret.
- Caller POSTs → engine validates HMAC signature (constant-time compare) → finds the workflow by `wh_{uuid}` → creates the run. No dedup possible (each call is a real event); idempotency comes from payload event-id + unique constraint.
- **Form variant (`/hooks/form_{uuid}`, implemented):** HTML forms can't sign requests, so the random path IS the credential. The engine parses `application/x-www-form-urlencoded` bodies into a flat fields object — steps address fields as `{{trigger.<field>}}` — and `GET` renders a sample form for a human to fill in.

### C. REST-hook triggers (outgoing subscription — v2)
- On enable, engine calls the trigger's `performSubscribe` (e.g. GitHub "create webhook") → third party returns an id → stored in `TriggerState`; third-party domain now POSTs to `wh_{uuid}`.
- On disable, `performUnsubscribe`. The incoming path then maps webhook → subscription → workflows.

**v1 ships B** (webhook, form) and the engine-initiated path (schedule + http.poll). REST-hook is a registry + `TriggerState` extension, not a new pipeline.

## Monorepo layout

```
apps/
  api/          REST server: auth, workflow CRUD, run history, replay, hooks receiver
  worker/       outbox poller + the generic execution consumer + reaper
  web/          Next.js: dashboard, workflow builder, trace viewer
packages/
  core/         engine types + generic executor (the "schema" of the platform)
  integrations/ the registry: every trigger/action definition, one file each
  db/           Prisma schema, migrations, seed
  mailer/       SMTP/log mail drivers (OTP + the email.send action)
  credentials/  AES-GCM vault: encrypt/decrypt, keyed by CREDENTIALS_KEY
```

The worker **never** contains action-specific logic. Adding an integration = one file in `packages/integrations` + a registry row, no worker changes. That is the platform trick (see the "declarative layer" in [decisions](07-decisions.md)).

## Related

- [data-model](03-data-model.md) — what each component reads/writes.
- [scaling](08-scaling.md) — when this single-box picture splits into more.