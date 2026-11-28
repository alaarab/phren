import { z } from "zod";

// The 0.3.100 reader's fields for an ordinary, unkeyed placement with a session.
// Keep this independent of the current request and receipt schemas.
export const legacyReceipt = z.strictObject({
  id: z.uuid(), computer: z.string(), computerId: z.uuid(), project: z.string(),
  harness: z.literal("codex"), label: z.string(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  state: z.literal("accepted"), brief: z.literal("typed"), startingToken: z.string().regex(/^[0-9a-f]{64}$/),
  launchOutcome: z.literal("started"), launchServer: z.string(),
  target: z.strictObject({ server: z.string(), workspace: z.string(), tab: z.string(), pane: z.string(),
    session: z.uuid(), source: z.literal("codex") }),
});
