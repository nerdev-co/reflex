# 04 — Execution Engine

The engine is a scoped distributed job runner. This document is the complete execution story: how a webhook becomes a finished run, and every failure mode in between.

## The job message

Every step of the DAG is its own job. One shape, four producers (webhook path, the scheduler's poll/schedule loop, full replay, replay-from-step):

```
Job = { runId, stepId }
```

The webhook path produces the first job through the **outbox** (docs/02):

1. `POST /hooks/wh_{uuid}` → HMAC validated
2. ONE transaction: `INSERT zap_runs (trigger_payload = raw body)`
3. `INSERT step_runs` (step 1, `queued`)
4. `INSERT zap_run_outbox (run_id, step_id)` ← the durability seam
5. The worker's **outbox poller** (3s tick, batch 10) does
   `enqueue { runId, stepId }` → `DELETE` the row — **delete AFTER the
   enqueue lands**, so a crash between 4 and 5 retries the row next tick,
   and the claim absorbs any duplicate.

**The run exists before anything executes.** That is what makes traces truthful. The publish path is idempotent by construction: the outbox row is the only thing between "committed" and "delivered", and exactly-once execution emerges from the claim.

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

## Engine utilities — filter, delay, formatter, per-step retry policy

The status machine above extends with two engine hooks and one builder knob;
the invariants (claim is the only lock, trace is append-only) never change.

### `evaluate` — a step may *end* the run without failing

`ActionDef.operation.evaluate?.(output)` is called after a successful
`perform`. Default `{ continue: true }`. A filter step returns
`{ continue: false, terminal: "FILTERED" }` when its condition is false:

- the step is **SUCCEEDED** (it did its job — test the condition) and its
  `{ matched: false }` output is recorded;
- the run ends **FILTERED** (new `RunStatus`) — not an error, so no retry,
  no dead-letter, no `run_failed`;
- downstream steps are **never inserted** (the DAG is walked lazily), so the
  trace stops exactly where the filter stopped it;
- events: `step_filtered`, `run_filtered`. Replay re-evaluates the identical
  recorded input — a filter can never behave differently on replay.

### `schedules` — delay as a state, not a thread

`ActionDef.schedules: true` (delay step) changes what a successful `perform`
means: instead of chaining, the worker parks the step in **WAITING** with
`nextAttemptAt` set to the returned `until`, and emits `delay_scheduled`.
The reaper's existing "due" query picks up WAITING rows, flips them back to
`queued` (`delay_enqueued`), and re-enqueues. The claim then runs the
**resume path**: if a claimed step's latest attempt already has output and no
error, the worker completes the chain (`delay_elapsed`, then `step_succeeded`)
without re-performing — so a delay's side effects happen exactly once, and a
crashed worker only delays the resume, never double-fires it.

The single attempt spans the whole wait; `attemptCount` stays 1. The same
resume rule also heals the crash window between *record* and *chain* for any
step (`step_resumed`). Constraints: perform must return a valid ISO `until`,
the total delay is capped at 24h, and `perform` must never sleep — the wait
lives in the row, not in a process.

### `meta.retry` — per-step policy from the builder

`steps[].meta.retry = { maxAttempts?, continueOnError? }` in the version
snapshot (sent by the builder, validated by the API, stored on `Step.meta`).
`maxAttempts` gates the retry/backoff state machine (default stays 3);
`continueOnError` turns the *terminal* failure path into "fail honestly, keep
going" — the step is `FAILED` and traced (`step_failed`, then
`step_failed_continued`), the run continues (or completes) without a
`run_failed`.

## Related

- [data-model](03-data-model.md) — the rows these transitions move.
- [decisions](07-decisions.md) — why at-least-once + DB-claim instead of exactly-once queues.