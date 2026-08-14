# 03 — Data Model

The schema is the anchor of the project: every component reads and writes these tables, and the whole design is forced by them. Three layers:

1. **Identity & auth** — users, sessions
2. **Configuration** — workflows, steps, the registry, credentials
3. **Execution history** — runs, step runs, attempts, events (the trace)

## 1. Identity & auth

```sql
users     id PK, email UNIQUE, password_hash, created_at
sessions  id PK, user_id FK, token_hash UNIQUE, expires_at, created_at
```

Simple on purpose. Passwords argon2id-hashed; sessions are server-side rows behind an httpOnly cookie (revocable, no JWT dance). Every query is scoped `WHERE user_id = <session.user_id>`.

## 2. Configuration

```sql
workflows          id PK, user_id FK, name, trigger_key, trigger_config JSONB,
                   status ('draft' | 'enabled' | 'disabled'),
                   version INT, created_at, updated_at

workflow_versions  id PK, workflow_id FK, version INT, definition JSONB,
                   -- full snapshot: trigger_config + ordered steps with configs
                   created_at
                   -- UNIQUE(workflow_id, version)

steps              id PK, workflow_id FK, position INT, action_key,
                   config JSONB, enabled BOOL
                   -- config is the template: { "channel": "{{trigger.payload...}}" }

available_triggers key PK, noun, type ('poll'|'webhook'|'schedule'), metadata JSONB
available_actions  key PK, noun, idempotent_safe BOOL, metadata JSONB
                   -- mirrors packages/integrations registry; synced at deploy

trigger_states     id PK, workflow_id FK, kind ('cursor'|'subscription'),
                   state JSONB, updated_at
                   -- poll cursors (last-seen ids) and webhook subscriptions

credentials        id PK, user_id FK, action_key, label, config JSONB,
                   created_at
                   -- secrets AES-GCM encrypted at rest; decrypted only in the worker
```

**Why workflow versions exist:** a run binds to the version that actually executed. When the user edits a workflow, `version` bumps and a new `workflow_versions` row snapshots the full definition. Replays bind to the *original run's* version, so a replayed trace describes something that could genuinely have happened — never a mix of old and new config.

## 3. Execution history — the trace

```sql
zap_runs
  id PK, workflow_id FK, workflow_version INT FK,
  trigger_key, trigger_payload JSONB,   -- FULL incoming payload, verbatim
  status ('pending'|'running'|'succeeded'|'failed'),
  replay_of_run_id NULL FK,             -- provenance: set only on replays
  created_at, started_at, finished_at

step_runs
  id PK, run_id FK, step_id FK, step_key,
  status ('queued'|'running'|'retrying'|'succeeded'|'failed'|'skipped'|'superseded'),
  config JSONB,                         -- snapshot of the step's template config
  attempt_count INT,
  output JSONB,                         -- last output (skipped steps inherit here)
  inherited_from_step_run_id NULL FK,   -- set when a replay inherits a completed step
  worker_id, enqueued_at, claimed_at, started_at, finished_at, next_attempt_at

step_run_attempts
  id PK, step_run_id FK, attempt_no INT,
  input JSONB,      -- payload ACTUALLY passed to perform (resolved, not template)
  output JSONB,     -- payload ACTUALLY returned
  error JSONB,      -- { class, message, stack, httpStatus }
  http_trace JSONB, -- request/response headers + body per attempt
  duration_ms, created_at
  -- append-only: every attempt, immutable

run_events
  id PK, run_id FK, at TIMESTAMP, type, data JSONB
  -- timeline: step_claimed, attempt_recorded, retry_scheduled,
  --           step_succeeded, step_failed, replay_created, dead_lettered
```

## Why each trace table exists

| Table | Answers | Notes |
|---|---|---|
| `zap_runs.trigger_payload` | "what came in?" | Stored in full — this is what makes replay possible *without regenerating a webhook*. |
| `step_runs` | "what is the current state?" | Mutable aggregate: claim logic, status queries. |
| `step_run_attempts` | "what exactly happened?" | Append-only forensic record. Few rows per step (≤ max attempts). |
| `run_events` | "in what order?" | The timeline the UI animates and live runs stream. |

Three deliberate choices:

1. **Input is snapshotted per attempt, not per step** — a retry re-runs `perform` with the same input; recording it per attempt proves the retry was faithful, or exposes the bug if it wasn't.
2. **`http_trace` per attempt** — the raw request/response is what makes debugging real instead of guesswork.
3. **`skipped` + `inherited_from_step_run_id`** — replay-from-failed-step materializes completed steps as `skipped` with copied outputs, so the replayed run's trace is complete and honest.

## Statuses, enumerated

**Step statuses:** `queued → running → (succeeded | retrying → queued … | failed | superseded)`. `skipped` is terminal-but-inherited; `superseded` means cancelled-by-replay (its pending retry must not fire).

**Run status:** derived only from the DAG tail — a run reaches a final status *when its last step terminates*. A failed step ⇒ `failed` even if earlier steps succeeded. Replays never mutate the original run: it stays as history, with a `replay_of_run_id` pointer the other way.

## Related

- [execution-engine](04-execution-engine.md) — the SQL that moves rows between these states.
- [observability-and-replay](05-observability-and-replay.md) — how these tables render as a trace.