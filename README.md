# Reflex

Event-driven workflow automation with **full execution observability and one-click replay** — Zapier-class trigger/action engine, but built around the failure case Zapier handles poorly: *you don't know what happened, and you can't re-run it.*

## Why this exists

Zapier is a black box when things fail. You get a vague "this zap failed" email, no visibility into what payload flowed through each step, and no way to replay a failed run with the exact same input.

Reflex is built so that failure is the primary UI. Every workflow run produces a **visual trace** — what payload came in, what each step transformed it to, where it broke — plus **one-click replay** of any run with the exact same payload. That turns debugging integrations from guesswork into inspection.

## Core scope

**Engine (the hard part):**

| Piece | Details |
|---|---|
| Triggers | Webhook, schedule (cron), form submit |
| Actions | HTTP request, Slack/Discord message, email |
| Execution engine | Event-driven `Trigger → Action` DAGs with a queue + worker pool (a scoped distributed job runner) |
| Reliability | Retries with exponential backoff, idempotency keys, dead-letter handling |

**Differentiator (the part Zapier doesn't do well):**

- **Execution observability** — full trace per run: input payload, each step's transformed output, timings, failure points.
- **Replay** — re-run any completed/failed run with the exact stored payload. No regenerating the trigger; replay the data as it actually flowed.

**Nice-to-haves on the roadmap:** dry-run mode (simulate a trigger with a mock payload against live workflows), sandboxed custom code steps.

## Architecture

```
                ┌──────────────────────────────────────────────┐
                │                    API layer                 │
                │   (workflow CRUD · run history · OAuth)      │
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
                                                     │  Run store          │
                                                     │  (traces, payloads, │
                                                     │   step outputs)     │
                                                     └──────────────────────┘
```

The execution engine **is** a distributed job runner: jobs are enqueued with a dedupe key, picked up by workers, executed with retry/backoff, and every mutation is recorded into the run store. The same reliability primitives that make this correct (idempotency, backoff, atomic state transitions) are the ones payment-retry systems depend on — it's the same problem class.

## Data model (anchor)

- **Workflow** — id, name, trigger config, list of steps, enabled state, version.
- **Step** — id, type (action/filter), config, position in the DAG.
- **Run** — id, workflow version, trigger payload (stored in full), status (`pending → running → succeeded/failed`), timestamps.
- **StepRun** — id, run id, step id, input payload, output payload, status, error, duration.
- **Replay** — id, original run id, new run id; marks the re-run's provenance so replays are auditable.

## Tech stack

- **Monorepo:** Turborepo + bun, shared `@repo/ui`, `@repo/typescript-config`, `@repo/eslint-config`
- **Apps:** `apps/web` (dashboard + workflow builder + run traces), `apps/docs` (design notes)
- **Runtime:** Next.js (planned), Redis-backed queue (planned), Postgres (planned)
- **Worker + API:** TypeScript, single language across the stack

## Documentation

The full design — architecture, data model, execution engine, observability/replay, API, decisions, and scaling — lives in [docs/](docs/README.md). Read it before writing code; the whole system was designed up front.

## Getting started

```sh
bun install
bun run dev        # or: bun run dev --filter=web
```

> Work in progress — the monorepo scaffold is in place; the engine is not built yet. See [docs/09-roadmap.md](docs/09-roadmap.md) for the build order.

## Roadmap

1. **Engine MVP** — trigger → queue → worker → action, retries, idempotency, run store
2. **Observability** — per-run traces in the UI, step-level payload inspection
3. **Replay** — replay endpoint + UI, provenance tracking
4. **Apps** — OAuth integrations, form trigger, email/Slack/Discord actions
5. **Extras** — dry-run mode, custom code step, self-host via Docker Compose

## Scripts

| Command | Purpose |
|---|---|
| `bun run dev` | Run all apps in dev mode |
| `bun run build` | Build all apps and packages |
| `bun run lint` | Lint all apps and packages |
| `bun run check-types` | Type-check all apps and packages |
| `bun run format` | Format all source files |
