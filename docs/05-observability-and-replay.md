# 05 — Observability & Replay

The differentiator. Zapier tells you a zap failed; Reflex shows you exactly what happened and lets you re-run it with the same data.

## The trace

Every record below exists to answer one question: *"what exactly happened, and can I prove it?"* (Schema in [data-model](03-data-model.md).)

- `zap_runs.trigger_payload` — full incoming payload, verbatim.
- `step_run_attempts.input` — payload *actually* passed to `perform` (resolved, not template).
- `step_run_attempts.output` — payload *actually* returned.
- `step_run_attempts.http_trace` — raw request/response per attempt.
- `run_events` — the timeline: claim, retries scheduled, failures, replay created.

## The UI

### Run list
Every run: status pill, workflow, trigger type, duration, `replayed` badge. Filterable by status and workflow.

### Run detail — the trace view (the product)

```
Run #4821 · "Slack on new GitHub issue" · v3 · FAILED            [▶ replay]
Trigger: webhook · received 42s ago · 1.2 KB payload

  ┌─────────┐   ┌─────────┐   ┌──────────┐   ┌─────────┐
  │ webhook │──►│ parse   │──►│  Slack   │──►│  email  │
  │ ✓ 12ms  │   │ ✓ 3ms   │   │ ✗ 2 retr │   │  skip   │
  └─────────┘   └─────────┘   └──────────┘   └─────────┘
                              ▲
                              click → step panel
```

Step panel for the failed step — the two details that make this stand out:

1. **Resolved input, not template**: config says `{{payload.issue.title}}`; the trace shows what it resolved to (`"Bun 1.3 crashes on ARM"`). Interpolation failures become visible instead of a mystery failure.
2. **Per-attempt drill-down with `http_trace`**: request headers, response body, and *why* the retry policy didn't fire (4xx → not transient).

```
Slack — attempt 2 of 3  (HTTP 401)

  attempt 1  attempt 2 ✗  attempt 3 (scheduled +8s)

  input (resolved):        output:              error:
  { channel: "#alerts",    (none)               oauth token expired
    text: "New issue #12 —  ── 4xx → no auto-
    {{payload.issue.title}}" }                    retry (validation)
```

### Live runs
SSE pushes `run_events` as they append; the node graph recolors as steps land. Same rendering code as the detail view — one `GET /runs/:id` + a subscription.

## The API contract the UI renders from

`GET /runs/:id` returns one JSON tree — no client-side joining, no N+1:

```json
{
  "run": { "id": "5102", "status": "running", "workflowVersion": 3,
           "replayOf": "4821", "trigger": { "type": "webhook",
           "payload": { "issue": { "title": "..." } } } },
  "steps": [
    { "stepKey": "slack.sendMessage", "status": "skipped",
      "inheritedFrom": 4821, "output": { "ok": true }, "durationMs": 12 },
    { "stepKey": "email.send", "status": "running", "attempts": [
        { "attemptNo": 1, "input": { "to": "a@b.c", "body": "resolved text" },
          "output": null, "error": null, "durationMs": 104 }
    ]}
  ],
  "events": [
    { "at": "...", "type": "replay_created", "data": { "of": 4821 } },
    { "at": "...", "type": "step_claimed", "data": {} }
  ]
}
```

## Replay — the semantics

Two modes, one rule underneath:

> **A replay never re-executes a step that already succeeded.** Completed steps already produced side effects; re-running duplicates them. Replay executes only from the first failed step onward; everything before it is *inherited*.

### Replay from failed step (the default fix)

Run #4821: webhook ✓ → parse ✓ → Slack ✓ → email ✗ (step 4). Click "replay from step 4."

```
NEW run #5102
  trigger_payload     ← COPIED from #4821 (verbatim, no re-fetch)
  workflow_version    ← #4821's version, NOT the current one
  replay_of_run_id    = #4821
  steps 1-3  → status='skipped', output copied, inherited_from_step_run_id set
  steps 4+   → status='queued', attempt_count=0, config from #4821's version
  events     → 'replay_created' { of: 4821 } at t0
```

Then it's the normal pipeline. Interpolation still works because inputs resolve from `trigger_payload` + *inherited* outputs.

### Full replay (the escape hatch)

Everything re-executes with new run ids and new idempotency keys. Used for "run the whole thing against today's world" — debugging environmental failures. Dedupe where APIs support it, duplicate effects where they don't — hence the warning.

### The three edge cases

1. **Uncertainty window on the failed step itself.** The email may have landed despite the recorded failure. Mitigations: the UI warns before replaying non-idempotent steps; optionally, the *first* replayed attempt sends idempotency key `${originalRunId}:${stepId}:${attempt}` so a Stripe-style API dedupes against the original attempt.
2. **Version drift.** The workflow may have been edited since the failure. Replay binds to the original run's `workflow_version` snapshot — the trace always describes something that could have actually happened.
3. **Pending retries in the original run.** A `retrying` step could fire its reaper retry *and* the replay's execution. Replay marks the original run's pending step_runs `superseded`, and the reaper filters them out.

### Immutability

The original run is never mutated — it stays as history, with a `replayed` badge linking forward. The replayed run gets its own verdict from its own last step.

## Related

- [api-and-auth](06-api-and-auth.md) — the replay endpoints.
- [scaling](08-scaling.md) — trace storage is the expensive part; retention is a real cost center.