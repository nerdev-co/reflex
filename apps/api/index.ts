// Reflex API — docs/06-api-and-auth.md.
// Bun + Hono. The run store (Postgres) is the source of truth; the in-memory
// queue is the dev stand-in for Redis (docs/02, docs/08).
import { Hono } from "hono";
import { logger } from "hono/logger";
import { authRoutes } from "./routes/auth.js";
import { workflowRoutes } from "./routes/workflows.js";
import { runRoutes } from "./routes/runs.js";
import { hookRoutes } from "./routes/hooks.js";
import { registryRoutes } from "./routes/registry.js";
import { credentialRoutes } from "./routes/credentials.js";
import { ApiError } from "./lib/errors.js";

export type AppEnv = {};

const app = new Hono<AppEnv>();
app.use("*", logger());

app.get("/health", (c) => c.json({ ok: true }));
app.route("/auth", authRoutes);
app.route("/workflows", workflowRoutes);
app.route("/runs", runRoutes);
app.route("/hooks", hookRoutes);
app.route("/", registryRoutes);
app.route("/credentials", credentialRoutes);

// Error envelope: { error: { code, message } }
app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as never);
  }
  console.error("Unhandled:", err);
  return c.json({ error: { code: "internal", message: "Internal server error" } }, 500 as never);
});

app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

const port = Number(process.env.PORT ?? 3001);

export default {
  port,
  fetch: app.fetch,
  hostname: "0.0.0.0",
};

console.log(`Reflex API listening on http://localhost:${port}`);
