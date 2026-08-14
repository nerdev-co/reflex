// Prisma's Json fields are strict about their input type; webhook payloads and
// configs arrive as `unknown`. Cast at the boundary, keep the rest typed.
import type { Prisma } from "@repo/db";

export const toJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;