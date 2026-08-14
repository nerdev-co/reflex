# Reflex — Project Documentation

This directory is the single source of truth for *what* Reflex is, *why* it exists, and *how* it is built. Everything here was designed up front, before the first engine commit — read these docs first, then write code against them.

## Reading order (10 minutes)

| # | Doc | What it answers |
|---|---|---|
| 01 | [vision](01-vision.md) | What is this? Why does it exist? What is deliberately *not* in scope? |
| 02 | [architecture](02-architecture.md) | The high-level system: components, data flow, trigger classes |
| 03 | [data-model](03-data-model.md) | The schema every component reads and writes — the anchor |
| 04 | [execution-engine](04-execution-engine.md) | How a run actually executes: claim, retry, idempotency, reaper |
| 05 | [observability-and-replay](05-observability-and-replay.md) | The differentiator: traces, the UI, replay semantics |
| 06 | [api-and-auth](06-api-and-auth.md) | Every endpoint, the auth model, webhook signatures |
| 07 | [decisions](07-decisions.md) | The trade-offs we already made and why — read before revisiting any design |
| 08 | [scaling](08-scaling.md) | How and when the system scales, and what it scaffolds into |
| 09 | [roadmap](09-roadmap.md) | Build order, milestones, definition of done |

## Status

Everything in these docs is **design, not implementation**. The monorepo scaffold (Turborepo + Next.js shells) exists; the engine, worker, data model, and API do not. The roadmap in `09` is the contract for what gets built next.

## Conventions used throughout

- **The queue is a delivery mechanism. The DB is the source of truth.** Every reliability argument in these docs follows from that sentence.
- Runs are **immutable history**. Replays create new runs; original runs are never mutated.
- Every schema/API decision exists because the trace UI or a third party needs it — nothing decorative.

## Related

- Root [README](../README.md) — position, one-paragraph pitch, quick start.
- `packages/integrations` (planned) — the registry of trigger/action definitions this docs set describes.