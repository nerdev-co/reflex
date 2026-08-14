# 04 — Execution Engine

The engine is a scoped distributed job runner. This document is the complete execution story: how a webhook becomes a finished run, and every failure mode in between.

## The job message

Every step of the DAG is its own job. One shape, three producers (webhook path, poll scheduler, replay):

```
Job = { runId, stepId }
```

The webhook path produces the first job:

1. `POST /hooks/wh_{uuid}` → HMAC validated
2. `INSERT zap_runs (trigger_payload = raw body)`
3. `INSERT step_runs` (step 1, `queued`)
4. `enqueue { runId, stepId }`

**The run exists before anything executes.** That is what makes traces truthful.

## The consume loop

```
processJob(job):
  claimed = claim(job)            # conditional UPDATE
  if !claimed: return             # someone else won — drop the duplicate
  event(runId, 'step_claimed')

  stepRun = loadStepRun(job.stepId)
  input   = resolveInput(stepRun) # interpolation
  def     = registry[stepRun.stepKey]   # lookup by key — no switch statement

  try:
    output = def.perform({
      payload: input,
      config: stepRun.config,
      auth: stepRun.auth,                    # stored credentials, decrypted here
      idempotencyKey: `${runId}:${stepId}:${attemptCount}`,
    })
    recordAttempt(stepRun, { input, output, error: null, durationMs })
    succeedStep(job, output)
  catch err:
    recordAttempt(stepRun, { input, output: null, error: classify(err), durationMs })
    handleFailure(job, stepRun, err)
  finally:
    ack(job)                      # worker is free; the DB is the record
```

### Claim — the lock

```sql
UPDATE step_runs
SET status = 'running', worker_id = $1, claimed_at = now()
WHERE id = $2 AND status = 'queued';
-- 0 rows affected → concurrent duplicate → drop the message
```

This is how **exactly-once execution per step** emerges from an at-least-once queue: the DB row is the lock, the message is just "check this row." `attemptCount` is read from the row, so retry schedules stay consistent across workers.

### Interpolation — where data flows between steps

Config templates: `{{trigger.payload.title}}`, `{{steps.1.output.name}}`.

```
resolveInput(stepRun):
  run = loadRun(stepRun.runId)
  return deepMap(stepRun.config, template =>
    scope = 'trigger'  → dig(run.triggerPayload, path)
    scope = 'steps'    → dig(run.stepOutputs[stepIndex], path))
```

The **resolved** result is stored as the attempt's `input` — the trace shows resolved values, and replay is deterministic regardless of template drift.

### Failure classification

```
transient = (err.type ∈ {network, timeout}) or (httpStatus ≥ 500)
canRetry  = attemptCount < maxAttempts
         and transient
         and registry[stepKey].idempotentSafe
```

- **4xx validation errors: never retried** — retrying them is theater.
- **Non-idempotent steps fail open** — the human decides via the trace, not the machine.

### Retry/backoff — a state, not a loop

Workers never sleep-and-retry (they'd burn capacity). On a retryable failure:

```
UPDATE step_runs SET status='retrying',
       next_attempt_at = now() + (1s · 2^attempt + jitter)   # 1s, 2s, 4s…
ack(job)                                                      # worker free immediately
```

The **reaper** (a cron on a ~5s tick) re-enqueues due retries — that's the entire retry mechanism.

### The reaper — three failure modes, one cron

```sql
-- 1. Due retries → back to queued + enqueue
SELECT * FROM step_runs
WHERE status='retrying' AND next_attempt_at <= now()
  AND status <> 'superseded';          -- replays cancel pending retries

-- 2. Stale claims → SIGKILLed workers
SELECT * FROM step_runs
WHERE status='running' AND claimed_at < now() - 60s;
-- → reset to 'queued', re-enqueue
```

| Failure mode | Resolution |
|---|---|
| Crash without ack | reaper reclaims → runs eventually |
| Duplicate message | claim loses → dropped |
| Retry due | reaper re-enqueues with backoff baked into `next_attempt_at` |
| Attempts exhausted | `failed`, dead-lettered, visible in trace with every attempt |

**No exactly-once queue required.** One reaper, four cases.

## The uncertainty window (the honest limit)

```
worker sends HTTP POST ──► network ──► API receives it
        │                             │
        └──── response lost ◄─────────┘
     worker sees "timeout", marks step failed
     retry fires → API may get the same request twice
```

You cannot close this window — a sent request whose response vanished is indistinguishable from one that never arrived. Mitigations:

1. **Idempotency key header** on outgoing calls: `X-Reflex-Idempotency-Key: {runId}:{stepId}:{attempt}`. APIs that support it (Stripe does) dedupe server-side. This is the "payment retry engine" pattern, verbatim.
2. **`idempotentSafe` classification** at definition time. Safe steps auto-retry; unsafe steps surface the failure and wait for a human.
3. **Be honest about it** — the UI warns before replaying non-idempotent steps, and the trace's `http_trace` shows whether a request likely landed.

## Run completion semantics

- A run's final status is decided **only when its last step terminates** — success chains the DAG (insert next `step_run`, enqueue), failure at any step ⇒ run `failed`.
- Runs are **immutable history**. Replays create new runs; the original is never mutated.
- Replay semantics are fully specified in [observability-and-replay](05-observability-and-replay.md).

## Related

- [data-model](03-data-model.md) — the rows these transitions move.
- [decisions](07-decisions.md) — why at-least-once + DB-claim instead of exactly-once queues.