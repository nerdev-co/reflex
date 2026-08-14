# 07 — Decisions (ADR log)

Every trade-off in this project was made deliberately, in one design session, before the first engine commit. Revisit any of these before changing the design — most are load-bearing.

## ADR-01: Zapier clone with a failure-first differentiator

**Context:** building "another workflow automation tool" is infinite scope and reads as a UI clone.
**Decision:** full e2e Zapier-class engine (proves the hard infra) + **execution observability and replay** as the differentiator — the pain point Zapier genuinely handles badly.
**Status:** accepted. This is the product.

## ADR-02: Rejected adjacent products

Video processing queue, search autocomplete, analytics event pipeline — all rejected as separate concerns (see [vision](01-vision.md)). The **payment retry engine** was the only idea folded in, as the retry/backoff/idempotency subsystem of the execution engine.

## ADR-03: At-least-once queue + DB claim, not an exactly-once queue

**Context:** exactly-once delivery is a lie you pay for; Kafka/Redis at-least-once is the honest baseline.
**Decision:** the queue is a delivery mechanism, the DB is the source of truth. Steps are claimed with a conditional `UPDATE … WHERE status='queued'`; duplicate messages lose the claim and are dropped. This yields exactly-once *execution per step* with zero exactly-once machinery.
**Consequence:** the whole reliability story (reaper, superseded status, attempts table) falls out of one sentence. See [execution-engine](04-execution-engine.md).

## ADR-04: Retries are a DB state, not a worker loop

Workers never sleep-and-retry. A retryable failure writes `status='retrying'` + `next_attempt_at` (backoff with jitter baked in) and acks the job. A reaper cron re-enqueues due retries and reclaims stale claims. Workers stay dumb, stateless, and horizontally scalable.

## ADR-05: Retry policy — only transient errors, only idempotent-safe steps

4xx validation errors are never retried (theater). Auto-retry only network/timeout/5xx **and** `idempotentSafe` steps. Non-idempotent steps fail open and let the human decide via the trace. The uncertainty window (request landed, response lost) is accepted as uncloseable and mitigated with idempotency-key headers, not denied.

## ADR-06: Replay never re-runs completed steps

Replay-from-failed-step materializes completed steps as `skipped` with inherited outputs; only the failed step onward re-executes. Replay always creates a **new run** with provenance (`replay_of_run_id`); originals are immutable history. Full replay exists as the explicit escape hatch. See [observability](05-observability-and-replay.md).

## ADR-07: Workflow versioning — runs bind to the version that executed

Edits bump `workflow_version` and snapshot the full definition. Replays bind to the *original run's* version so a trace always describes something that could have happened. This is why `zap_runs.workflow_version` is load-bearing, not decoration.

## ADR-08: The platform trick — definitions as data + one `perform` function

Actions/triggers are declarative definitions (`inputFields`, `sample`, `perform`) registered by key. The worker is a generic executor — lookup by key, call `perform`, record the attempt. Adding an integration = one file in `packages/integrations`, zero worker changes. `sample` gives dry-run for free. This is the abstraction that separates a forwarding service from a platform. (Learned from studying `zapier-platform`: schema + metadata for UI/testability, functions for execution.)

## ADR-09: Interpolation stored as resolved values

The trace stores the *resolved* input per attempt, not the template. Interpolation failures become visible, replay is deterministic, and "what actually happened" is never ambiguous.

## ADR-10: Email + password — sessions AND a no-JWT token ladder

Sessions are server-side rows behind an httpOnly cookie: revocable, no JWT library. For API clients that can't take cookies, access tokens are stateless **HMAC envelopes** (node:crypto, 15 min — still no JWT dependency), paired with rotated single-use refresh tokens (hashed at rest, revoked by reset/logout). OAuth connections for third-party actions are a separate mechanism (credentials table), decoupled from user auth.

## ADR-11: Webhook secrets, not session auth, for hooks

Hooks are public by design and authenticated by HMAC signature over the raw body with constant-time comparison. The unguessable `wh_{uuid}` URL is half the defense.

## ADR-12: Trace storage is the expensive part

Payloads are duplicated per attempt by design (forensic value beats storage cost at v1 scale). Retention TTL on attempts is planned; "observability storage is where the unit economics live" is the honest answer if asked.

## Related

- [scaling](08-scaling.md) — when these decisions start to need revisiting.