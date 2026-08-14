// The platform contract — see docs/02-architecture.md ("The declarative layer").
// Every trigger/action definition in packages/integrations conforms to these
// types. The worker is a generic executor: lookup by key, call `perform`,
// record the attempt. Adding an integration never touches the worker.

export type FieldType = "string" | "text" | "number" | "boolean" | "json";

export interface Field {
  key: string;
  type?: FieldType;
  label?: string;
  required?: boolean;
  default?: unknown;
  helpText?: string;
}

export interface PerformContext {
  /** Resolved input for this step (templates already interpolated — ADR-09). */
  payload: unknown;
  /** Step config with interpolated values (worker resolved `{{...}}` before calling). */
  config: Record<string, unknown>;
  /** Stored credentials, decrypted by the worker at execution time. */
  auth: Record<string, unknown>;
  /** `{runId}:{stepId}:{attempt}` — send as X-Reflex-Idempotency-Key where the API supports it. */
  idempotencyKey?: string;
  /** Dry-run mode: never touch real APIs, return `sample`-shaped output (ADR: dry-run differentiator). */
  dryRun?: boolean;
  /** Raw incoming request — only set for webhook trigger perform calls. */
  rawRequest?: unknown;
}

export interface Operation {
  /** Drives the builder UI forms (rendered from the registry endpoints). */
  inputFields: Field[];
  /** Fake-but-shaped output for dry-run and "test step" without live calls. */
  sample: Record<string, unknown>;
  /** The imperative kernel executed by the engine. */
  perform: (ctx: PerformContext) => Promise<unknown>;
}

export type TriggerType = "POLL" | "WEBHOOK" | "SCHEDULE";

export interface TriggerDef {
  key: string;
  noun: string;
  type: TriggerType;
  operation: Operation;
}

export interface ActionDef {
  key: string;
  noun: string;
  /** If true, the engine auto-retries this step (ADR-05). If false, failures surface to the human. */
  idempotentSafe: boolean;
  operation: Operation;
}
