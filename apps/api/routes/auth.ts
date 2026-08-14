import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  getUserBySession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "../lib/auth.js";
import { errors } from "../lib/errors.js";
import type { AppContext } from "../lib/context.js";

export const authRoutes = new Hono();

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

async function getBody(c: AppContext) {
  return c.req.json().catch(() => null);
}

authRoutes.post("/register", async (c: AppContext) => {
  const body = credentialsSchema.safeParse(await getBody(c));
  if (!body.success) throw errors.badRequest("Invalid email or password (min 8 chars)");

  const { email, password } = body.data;
  const normalized = email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) throw errors.conflict("Email already registered");

  const user = await prisma.user.create({
    data: { email: normalized, passwordHash: await hashPassword(password) },
  });

  const token = await createSession(user.id);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });

  return c.json({ user: { id: user.id, email: user.email } }, 201);
});

authRoutes.post("/login", async (c: AppContext) => {
  const body = credentialsSchema.safeParse(await getBody(c));
  if (!body.success) throw errors.badRequest("Invalid email or password");

  const { email, password } = body.data;
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) throw errors.unauthorized("Invalid credentials");
  if (!(await verifyPassword(password, user.passwordHash))) throw errors.unauthorized("Invalid credentials");

  const token = await createSession(user.id);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });

  return c.json({ user: { id: user.id, email: user.email } });
});

authRoutes.post("/logout", async (c: AppContext) => {
  await destroySession(getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE);
  return c.json({ ok: true });
});

authRoutes.get("/me", async (c: AppContext) => {
  const user = await getUserBySession(getCookie(c, SESSION_COOKIE));
  if (!user) throw errors.unauthorized();
  return c.json({ user: { id: user.id, email: user.email } });
});