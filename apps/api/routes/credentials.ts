// Credentials — action auth, decoupled from user auth (docs/06).
// Secrets are AES-GCM encrypted at rest; decrypted only in the worker at
// execution time; never included in traces.
import { Hono } from "hono";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { getCookie } from "hono/cookie";
import { prisma } from "../lib/prisma.js";
import { errors } from "../lib/errors.js";
import { getUserBySession, SESSION_COOKIE } from "../lib/auth.js";
import type { AppContext } from "../lib/context.js";

export const credentialRoutes = new Hono();

const ENCRYPTION_KEY = Buffer.from(process.env.CREDENTIALS_KEY ?? "reflex-dev-key-32-bytes-0123456789ab", "utf8").subarray(0, 32);

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(payload: string): string {
  const [iv, tag, data] = payload.split(".").map((s) => Buffer.from(s, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8");
}

async function requireUser(c: AppContext) {
  const user = await getUserBySession(getCookie(c, SESSION_COOKIE));
  if (!user) throw errors.unauthorized();
  return user;
}

const credentialSchema = z.object({
  actionKey: z.string(),
  label: z.string().min(1).max(100),
  config: z.record(z.unknown()),
});

credentialRoutes.get("/", async (c: AppContext) => {
  const user = await requireUser(c);
  const credentials = await prisma.credential.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
  // Never return the encrypted config — the API is not the decryption point.
  return c.json({ credentials: credentials.map(({ config, ...cred }) => cred) });
});

credentialRoutes.post("/", async (c: AppContext) => {
  const user = await requireUser(c);
  const parsed = credentialSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw errors.badRequest("Invalid credential");
  const { actionKey, label, config } = parsed.data;

  const credential = await prisma.credential.create({
    data: {
      userId: user.id,
      actionKey,
      label,
      config: { encrypted: encryptSecret(JSON.stringify(config)) },
    },
  });
  return c.json({ credential }, 201);
});

credentialRoutes.delete("/:id", async (c: AppContext) => {
  const user = await requireUser(c);
  const existing = await prisma.credential.findFirst({ where: { id: c.req.param("id"), userId: user.id } });
  if (!existing) throw errors.notFound("Credential not found");
  await prisma.credential.delete({ where: { id: existing.id } });
  return c.json({ ok: true });
});