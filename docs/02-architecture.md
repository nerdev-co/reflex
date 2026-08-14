# 02 — Architecture

## High-level system

```
                ┌──────────────────────────────────────────────┐
                │                   API layer                  │
                │  (workflow CRUD · run history · auth · OAuth)│
                └──────────────┬───────────────────────────────┘
                               │
   webhook ──► ┌───────────────▼───────────────┐
   schedule ──►│        Trigger service        │──► ┌──────────────────────┐
   form    ──► │   (validate, enrich, dedupe)  │──► │   Job queue (Redis)  │
               └───────────────────────────────┘    │  (idempotency keys) │
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
Converts "an event happened" into "a run exists." Three trigger classes, implemented differently (below). Produces `Job = { runId, stepId }` messages.

### Job queue
Distributed FIFO + delayed delivery (due-retry re-enqueue). At-least-once semantics are fine — the DB claim handles duplicates. In-process for dev, Redis for prod.

### Workers
Stateless consumers. Claim a step via conditional UPDATE, resolve the step's input (interpolation), look up the action definition from the registry, call its `perform`, record the attempt, chain the DAG or schedule a retry. See [execution-engine](04-execution-engine.md).

### Run store (Postgres)
`zap_runs`, `step_runs`, `step_run_attempts`, `run_events`, plus the registry and credentials tables. See [data-model](03-data-model.md).

### Reaper
A lightweight cron (a few-second tick) with two jobs:
1. Re-enqueue `retrying` steps whose `next_attempt_at` has passed (the actual retry mechanism — workers never sleep).
2. Reclaim `running` steps whose `claimed_at` is stale (workers that were SIGKILLed mid-execution).

## Trigger classes — the engine implements each differently

### A. Polling triggers (engine-initiated)
- A scheduler fires every N minutes per workflow.
- Engine calls the trigger definition's `perform` → a *list* of items.
- **Dedup:** each item carries an `id`; the engine tracks last-seen ids in `TriggerState`; only new ids create runs.

### B. Incoming webhook triggers (GitHub, form submit)
- Engine *exposes* a URL: `https://reflex.app/hooks/wh_{uuid}` plus a per-webhook secret.
- Caller POSTs → engine validates HMAC signature (constant-time compare) → finds the workflow by `wh_{uuid}` → creates the run. No dedup possible (each call is a real event); idempotency comes from payload event-id + unique constraint.

### C. REST-hook triggers (outgoing subscription — v2)
- On enable, engine calls the trigger's `performSubscribe` (e.g. GitHub "create webhook") → third party returns an id → stored in `TriggerState`; third-party domain now POSTs to `wh_{uuid}`.
- On disable, `performUnsubscribe`. The incoming path then maps webhook → subscription → workflows.

**v1 only needs B** (webhook, form) and the engine-initiated path (schedule). REST-hook is a registry + `TriggerState` extension, not a new pipeline.

## Monorepo layout

```
apps/
  api/          REST server: auth, workflow CRUD, run history, replay, hooks receiver
  worker/       the generic execution consumer
  web/          Next.js: dashboard, workflow builder, trace viewer
packages/
  core/         engine types + generic executor (the "schema" of the platform)
  integrations/ the registry: every trigger/action definition, one file each
  db/           Prisma schema, migrations, seed
```

The worker **never** contains action-specific logic. Adding an integration = one file in `packages/integrations` + a registry row, no worker changes. That is the platform trick (see the "declarative layer" in [decisions](07-decisions.md)).

## Related

- [data-model](03-data-model.md) — what each component reads/writes.
- [scaling](08-scaling.md) — when this single-box picture splits into more.