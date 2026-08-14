# 01 — Vision

## What Reflex is

Reflex is an event-driven workflow automation platform in the Zapier class: users define a **trigger** ("GitHub issue opened") and a chain of **actions** ("post to Slack, then email me"), and a reliable execution engine makes it happen — with retries, idempotency, and full visibility into every run.

The base product proves we can build the hard infra: triggers, actions, an execution engine, queue-backed workers, retries, idempotency, DAGs.

The differentiator is what Zapier does badly: **failure visibility and recovery**.

## Why it exists

Zapier is a black box when things fail. You get a vague "this zap failed" email. There is no answer to the three questions every integration engineer asks:

1. What payload actually came in?
2. What did each step transform it into?
3. Where exactly did it break — and can I run it again with the exact same data?

Reflex is built so **failure is the primary UI**: every run produces a visual trace (input payload, per-step transformed output, timings, failure point) and supports **one-click replay** of any run with the exact stored payload.

## Positioning

Not "workflow automation for everyone" — that is infinite scope and feels derivative. The product posture is: **an automation engine built around the failure case Zapier hides.**

Framing that lands with engineers:

> "I understand why Zapier is hard." — the engine does claim-based execution, retries, idempotency keys, and DAG chaining, because those are the hard parts.
>
> "And I built the thing Zapier doesn't have" — per-run traces and replay.

## Locked scope (v1)

| Trigger | Class | Engine work |
|---|---|---|
| Webhook | incoming | generated `wh_{uuid}` URL + HMAC validation |
| Schedule | polling (engine-initiated) | cron scheduler, fire once per tick |
| Form submit | incoming | webhook + stored submission row |

| Action | Notes |
|---|---|
| HTTP request | the generic workhorse, carries `http_trace` |
| Slack / Discord message | message via webhook/API token |
| Email | SMTP / provider |

**Infra backbone:** queue + worker pool (a scoped distributed job runner) with retry/backoff, idempotency keys, dead-lettering, and the reaper.

**Differentiator:** per-run execution observability (traces) + one-click replay.

**Extras on the roadmap, not v1:** dry-run mode (`sample`-driven testing), sandboxed custom code steps, self-host via Docker Compose.

## What was considered and rejected

| Idea | Verdict | Why |
|---|---|---|
| Analytics event pipeline (Segment/PostHog-style) | separate product | Data-flow-out for reporting, not "if X then Y". Would reuse some plumbing (ingestion, queues) but it's not automation. |
| Video processing queue | rejected | Media transcoding concern; doesn't fit the workflow engine. |
| Search autocomplete | rejected | Indexing/ranking problem, unrelated. |
| Payment retry engine as a *product* | folded in | It's a specific instance of the engine's reliability core (retry/backoff/idempotency). The engine is designed generic enough to handle payment-style retries — that's a talking point, not a feature. |
| "Everything" trigger/action marketplace | rejected for v1 | Registry architecture supports it later; 3 triggers + 3 actions ship the engine. |

## How this is judged

- **Engine correctness:** a run either executes exactly once per step (in the intended semantics) or fails loudly with a complete trace — never silently half-runs.
- **Differentiator quality:** any failed run can be inspected to the payload level and replayed with one click.
- **Interview story:** the design shows understanding of distributed-systems failure modes — at-least-once delivery, the uncertainty window, idempotency, versioned runs, provenance.

## Related

- [architecture](02-architecture.md) — how the scope becomes a system.
- [decisions](07-decisions.md) — the trade-offs made while locking this scope.