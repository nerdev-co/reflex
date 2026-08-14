// Registry endpoints — serve the builder UI its dynamic forms (docs/06).
import { Hono } from "hono";
import { triggers, actions } from "@repo/integrations";
import { getCookie } from "hono/cookie";
import { getUserBySession, SESSION_COOKIE } from "../lib/auth.js";
import { errors } from "../lib/errors.js";
import type { AppContext } from "../lib/context.js";

export const registryRoutes = new Hono();

async function requireUser(c: AppContext) {
  const user = await getUserBySession(getCookie(c, SESSION_COOKIE));
  if (!user) throw errors.unauthorized();
  return user;
}

registryRoutes.get("/triggers", async (c: AppContext) => {
  await requireUser(c);
  return c.json({
    triggers: Object.values(triggers).map((t) => ({
      key: t.key,
      noun: t.noun,
      type: t.type,
      inputFields: t.operation.inputFields,
      sample: t.operation.sample,
    })),
  });
});

registryRoutes.get("/actions", async (c: AppContext) => {
  await requireUser(c);
  return c.json({
    actions: Object.values(actions).map((a) => ({
      key: a.key,
      noun: a.noun,
      idempotentSafe: a.idempotentSafe,
      inputFields: a.operation.inputFields,
      sample: a.operation.sample,
    })),
  });
});