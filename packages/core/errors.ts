// Error classification — the worker's retry decision uses this (docs/04, ADR-05).
// Rules:
//  - transient kinds (network | timeout | server) are retryable,
//    but only when the definition is idempotentSafe
//  - validation | auth are permanent — retrying them is theater

export type ErrorKind = "network" | "timeout" | "validation" | "auth" | "server" | "unknown";

export const TRANSIENT_KINDS: ReadonlySet<ErrorKind> = new Set(["network", "timeout", "server"]);

export function isTransient(kind: ErrorKind): boolean {
  return TRANSIENT_KINDS.has(kind);
}

export class StepError extends Error {
  readonly kind: ErrorKind;
  readonly httpStatus?: number;

  constructor(kind: ErrorKind, message: string, httpStatus?: number) {
    super(message);
    this.name = "StepError";
    this.kind = kind;
    this.httpStatus = httpStatus;
  }

  toJSON() {
    return {
      class: this.name,
      message: this.message,
      httpStatus: this.httpStatus,
    };
  }
}

export interface ClassifiedError {
  kind: ErrorKind;
  httpStatus?: number;
  message: string;
}

export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof StepError) {
    return { kind: err.kind, httpStatus: err.httpStatus, message: err.message };
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return { kind: "timeout", message: err.message };
    }
    return { kind: "unknown", message: err.message };
  }
  return { kind: "unknown", message: String(err) };
}
