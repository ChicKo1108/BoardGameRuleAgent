import { z } from "zod";
export const sessionView = z.object({
  kind: z.literal("guest"),
  expiresAt: z.iso.datetime(),
  quota: z.object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    limit: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    resetAt: z.iso.datetime(),
  }),
});
