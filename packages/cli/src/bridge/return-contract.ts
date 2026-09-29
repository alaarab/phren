import { z } from "zod";
import { computerName, targetSchema } from "./protocol.js";
export const reportText = (max: number) => z.string().max(max).refine(s => !/[\x00-\x08\x0b-\x1f\x7f]/.test(s));
export const pullRequestSchema = z.object({
  url: z.url().max(1000).refine(url => { const parsed = new URL(url); return parsed.protocol === "https:" && !parsed.username && !parsed.password; }, "Use an HTTPS PR URL."),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),
  branch: reportText(200).min(1), tests: reportText(2000), notes: reportText(4000).optional(),
}).strict();
export const prsSchema = z.array(pullRequestSchema).min(1).max(16).refine(rows => Buffer.byteLength(JSON.stringify(rows), "utf8") <= 24000, "PR evidence must fit within 24000 UTF-8 bytes.");
export type PullRequest = z.infer<typeof pullRequestSchema>;
export const integratorSchema = z.object({ computer: computerName.optional(), target: targetSchema }).strict();
export type Integrator = z.infer<typeof integratorSchema>;
