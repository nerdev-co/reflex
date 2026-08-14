// Shared errors + response envelope — docs/06-api-and-auth.md.
// Every error is `{ error: { code, message } }` with a matching HTTP status.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function error(status: number, code: string, message: string): ApiError {
  return new ApiError(status, code, message);
}

export const errors = {
  badRequest: (msg = "Invalid request") => error(400, "bad_request", msg),
  unauthorized: (msg = "Not authenticated") => error(401, "unauthorized", msg),
  forbidden: (msg = "Not allowed") => error(403, "forbidden", msg),
  notFound: (msg = "Not found") => error(404, "not_found", msg),
  conflict: (msg = "Conflict") => error(409, "conflict", msg),
};
