// Auth primitives — ADR-10: email + password, server-side sessions (docs/06).
// Passwords: argon2id. Sessions: random token, DB stores only its hash.
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./prisma.js";
import { errors } from "./errors.js";

const SESSION_COOKIE = "reflex_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: { tokenHash: tokenHash(token), userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  return token;
}

export async function getUserBySession(token: string | undefined) {
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { tokenHash: tokenHash(token) } });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  return user;
}

export async function destroySession(token: string | undefined) {
  if (!token) return;
  await prisma.session.delete({ where: { tokenHash: tokenHash(token) } }).catch(() => {});
}

export { SESSION_COOKIE, SESSION_TTL_MS };

export { errors };