# 09 — Roadmap

Build order toward the Stage-0 single-box deployment ([scaling](08-scaling.md)). Each phase has an exit condition — do not start the next phase until the current one is *proven*, not just written.

## Phase 1 — Engine core

The point where "it's a design" becomes "it runs."

- Monorepo layout: `apps/api`, `apps/worker`, `apps/web`, `packages/core`, `packages/integrations`, `packages/db`.
- Prisma schema per [data-model](03-data-model.md) — users, sessions, workflows, versions, steps, runs, step_runs, attempts, events.
- `packages/core` — `TriggerDef`/`ActionDef` types (the contract), job shape, claim helper.
- Registry: first two definitions — `webhook` trigger, `http.request` action.
- Worker loop: claim → interpolate → `perform` → record → chain.
- Reaper: due retries + stale claims.

**Exit condition:** a run through the full pipeline — webhook in, two steps executed, `GET /runs/:id` returns a correct trace. A failed HTTP step retries with backoff and eventually dead-letters with full attempts recorded.

## Phase 2 — Actions and triggers to locked scope

- Actions: Slack/Discord message, email (SMTP). All via `packages/integrations` — worker unchanged.
- Triggers: schedule (cron, engine-initiated path), form submit (`/hooks/form_{uuid}`).
- Credentials: encrypted at rest, decrypted in worker, never in traces.

**Exit condition:** all three triggers × three actions work end to end, and adding a new action is provably a registry-only change.

## Phase 3 — The differentiator

- Trace view in `apps/web`: run list, run detail (status node graph, step panel, per-attempt drill-down), live runs via SSE on `run_events`.
- Replay endpoints: `POST /runs/:id/replay`, `POST /runs/:id/replay-from-step`.
- Replay semantics per [observability](05-observability-and-replay.md): skipped/inherited steps, version binding, `superseded` retry cancellation, warnings on non-idempotent replays.

**Exit condition:** a failed run is fully inspectable to payload level and replayable with one click — from the same data the worker already writes (no new recording code paths).

## Phase 4 — Hardening & UX

- Dry run: `POST /workflows/:id/test` with `sample`-driven execution, `dryRun: true` in `perform`.
- Auth polish: rate limiting, session expiry, webhook secret management UI.
- Error handling contract, zod validation across the API.

## Phase 5 — Ship

- Docker Compose single-box deploy.
- Seed data + demo workflow.
- Root README updated with live URLs.

## Post-v1 (deliberately not scheduled)

- REST-hook triggers (`performSubscribe`/`performUnsubscribe`).
- Custom code step (sandboxed JS/Python `perform`).
- Workspaces/teams.
- Self-host docs + one-command up.
- Trace retention TTLs when attempts storage grows ([scaling](08-scaling.md)).

## Definition of done (from the vision)

1. **Engine correctness:** every run executes in the intended semantics or fails loudly with a complete trace — never silently half-runs.
2. **Differentiator quality:** any failed run is inspectable to payload level and one-click replayable.
3. **Interview story:** the design (DB-claim execution, retry state machine, uncertainty window, versioned runs, provenance) holds up to questions — the docs in this directory are the script.