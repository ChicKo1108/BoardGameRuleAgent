import { z } from "zod";
import { verifiedAnswer } from "./answering.ts";
const uuid = z.uuid().toLowerCase(),
  count = z.number().int().nonnegative();
export const createConversation = z.strictObject({
  idempotencyKey: uuid,
  rulesetId: uuid,
});
export const messageInput = z.strictObject({
  idempotencyKey: uuid,
  expectedRevision: count,
  question: z.string().trim().min(1).max(2000),
});
export const conversation = z.object({
  id: uuid,
  rulesetId: uuid,
  publicationId: uuid,
  revision: count,
  createdAt: z.iso.datetime(),
});
export const turn = z.object({
  id: uuid,
  conversationId: uuid,
  sequence: count,
  question: z.string(),
  publicationId: uuid,
  state: z.enum(["prepared", "running", "completed", "failed"]),
  answer: verifiedAnswer.nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
