# 08 — Scaling

How the system grows, when each stage is triggered, and what the design scaffolds into beyond the Zapier clone.

## The scaling principle

Grow by **splitting processes, not redesigning**. The DB-claim execution model was chosen so that every stage below is a deployment change, not a schema change. At every stage: the queue is delivery, the DB is truth, runs are immutable history.

## Stage 0 — single box (v1 target)

```
┌──────────────────────────────────────────────┐
│  one server (Docker Compose)                 │
│  api + trigger service + worker + reaper     │
│  Postgres · Redis (queue)                    │
└──────────────────────────────────────────────┘
```

**Fits:** personal-to-small-team usage. Hundreds of workflows, low-thousands of runs/day. Correctness and the trace experience are the goals, not throughput.

**Bottlenecks to watch** (each one is the *trigger* for the next stage):
- Worker CPU: the 4xx/5xx/network calls serialize on one process.
- Queue depth: webhook bursts spike latency.
- DB write volume: every run writes ~1 + N + attempts rows.

## Stage 1 — workers as a separate, multi-process tier

```
webhook burst ──► api/trigger ──► Redis queue ──► worker x N (same box or +1)
                                                     │
                                                     ▼
                                              Postgres
```

**When:** queue depth grows, or one slow action (a 30s email timeout) backs up the run pipeline. **Splitting at process granularity means a hung third-party API stops one worker, not the whole system.**

Scale workers by:
- **No state on the worker** (already true by design — retries live in the DB).
- **Partition keys on jobs**: `runId` as the partition key, so a run's steps execute in order on one worker, and different runs parallelize.

## Stage 2 — horizontal workers + sharded reaper

**When:** queue latency is dominated by DB contention (claim updates per step) or workers outgrow the box.

- Multiple worker machines, same queue, same DB. The claim `UPDATE` is what makes this safe — duplicate delivery across machines loses the race.
- The reaper splits by **shard key** (`worker_id % N` or range on `id`) so retry scans don't overlap.
- The scheduler (poll triggers) becomes its own process with leader election — one leader emits cron ticks, no double-firing.

**What does *not* change:** schema, API, the claim SQL, the trace contract. This is the payoff of ADR-03.

## Stage 3 — what the design can grow into

The boundaries were drawn to make these natural, but they are **not v1**:

| Growth | When | What it takes |
|---|---|---|
| **REST-hook triggers** | post-v1 | `performSubscribe`/`performUnsubscribe` + `TriggerState` subscriptions — no pipeline change |
| **Workspaces / teams** | multi-tenant real users | one `workspace_id` column + scoping, no engine change |
| **Custom code step** | power users | a sandboxed `perform` variant (JS/Python) registered like any action |
| **Self-hosting** (Docker Compose, one command) | dev-love story | packaging + env config; the engine is already DB+Redis, vendor-free |
| **Analytics adjacency** | separate product | reuses ingestion/queue plumbing, but it's data-flow-out, not automation |

## The reliability core is portable

The engine's primitives — claim-based exactly-once execution, retry state with backoff, idempotency keys, immutable history, replay — are the same primitives payment systems run on. This is deliberate (ADR-02): the "payment retry engine" idea was folded in, not built separately. When talking about the project, the execution engine *is* a distributed job runner with payment-grade reliability thinking applied to integrations.

## Capacity expectations (honest)

At v1 scale, this system handles thousands of runs/day trivially on one box. When numbers get serious:

- **Runs** → the heavy table is `step_run_attempts` (payload duplication by design). Retention TTL (e.g. 30 days on attempts) is the cost control; old runs keep their `run` row but lose attempt bodies.
- **Webhook ingress** → the trigger service is stateless behind a load balancer; HMAC validation is pure CPU.
- **Queue** → Redis is fine until sustained high throughput; Kafka becomes the swap-in and the job contract (`{ runId, stepId }`) doesn't change.

## Related

- [roadmap](09-roadmap.md) — the build order toward Stage 0.