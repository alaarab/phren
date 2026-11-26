import { z } from "zod";

export const RECALL_NEGATIVE_CLASSES = ["conversational", "off-domain", "cross-project-lure", "typo", "envelope", "other-tool"] as const;
export const RECALL_TIERS = ["active", "topic", "older"] as const;

export const recallEvalCaseSchema = z.object({
  id: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  project: z.string().trim().min(1).nullable(),
  kind: z.enum(["negative", "positive"]),
  class: z.string().trim().min(1),
  relevant: z.array(z.object({
    project: z.string().trim().min(1),
    fid: z.string().regex(/^[a-f0-9]{8}$/),
    match: z.string().trim().min(1),
  }).strict()),
  tier: z.enum(RECALL_TIERS).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === "positive" && (!value.relevant.length || value.tier === null)) {
    ctx.addIssue({ code: "custom", message: "Positive cases need relevant findings and a tier" });
  }
  if (value.kind === "negative" && (value.relevant.length || value.tier !== null || !RECALL_NEGATIVE_CLASSES.some(c => c === value.class))) {
    ctx.addIssue({ code: "custom", message: "Negative cases need a known negative class, no relevant findings and a null tier" });
  }
});

export type RecallEvalCase = z.infer<typeof recallEvalCaseSchema>;
