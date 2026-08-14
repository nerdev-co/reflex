// The unit of work in the queue (docs/04-execution-engine.md).
// Three producers create jobs: webhook path, poll scheduler, replay.
// The queue is a delivery mechanism; the DB rows are the source of truth.

export interface Job {
  runId: string;
  stepId: string;
}
