import { StepError, type ActionDef } from "@repo/core";

const REQUEST_TIMEOUT_MS = 30_000;

function httpStatusKind(status: number): "server" | "auth" | "validation" {
  if (status >= 500) return "server";
  if (status === 401 || status === 403) return "auth";
  return "validation";
}

function toHeaders(headers: unknown): Record<string, string> {
  if (typeof headers === "string") {
    try {
      return JSON.parse(headers) as Record<string, string>;
    } catch {
      throw new StepError("validation", "headers must be valid JSON");
    }
  }
  if (headers && typeof headers === "object") return headers as Record<string, string>;
  return {};
}

// Generic HTTP request — the workhorse action (docs/01-vision.md).
// Captures request/response into the return value so the worker can persist
// `http_trace` per attempt.
export const httpRequest: ActionDef = {
  key: "http.request",
  noun: "HTTP Request",
  idempotentSafe: true,
  operation: {
    inputFields: [
      { key: "method", type: "string", default: "GET", required: true },
      { key: "url", type: "string", required: true },
      { key: "headers", type: "string", helpText: "JSON object of headers" },
      { key: "body", type: "json", helpText: "Request body — templates supported" },
    ],
    sample: { status: 200, body: { ok: true } },
    perform: async ({ config, idempotencyKey, dryRun }) => {
      if (dryRun) return httpRequest.operation.sample;

      const method = String(config.method ?? "GET").toUpperCase();
      const url = String(config.url);
      const headers = toHeaders(config.headers);

      // ADR: uncertainty window mitigation — idempotency key header on mutations.
      if (idempotencyKey && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        headers["X-Reflex-Idempotency-Key"] = idempotencyKey;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: config.body != null && method !== "GET" && method !== "HEAD" ? JSON.stringify(config.body) : undefined,
          signal: controller.signal,
        });

        const text = await response.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // keep raw text
        }

        if (response.status >= 400) {
          throw new StepError(httpStatusKind(response.status), `HTTP ${response.status} ${response.statusText}`, response.status);
        }

        return {
          status: response.status,
          body,
          headers: Object.fromEntries(response.headers.entries()),
        };
      } catch (err) {
        if (err instanceof StepError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          throw new StepError("timeout", `Request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`);
        }
        throw new StepError("network", `Failed to reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    },
  },
};
