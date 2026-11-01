/** Private-store links only. Never encode a task identity in Git or forge data. */
import { z } from "zod";
export const mergeTaskIdentitySchema = z.object({ storeId: z.string().regex(/^[a-f0-9]{8}$/), project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/), stableId: z.string().regex(/^[a-f0-9]{8}$/) }).strict();
const repo = z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const branchLinkSchema = z.object({ repo, name: z.string().min(1).max(200).refine(s => !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(s) && !s.startsWith("-") && !s.includes("..")) }).strict();
export const prLinkSchema = z.object({ repo, number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const taskLinksSchema = z.object({
  version: z.literal(1), branches: z.array(branchLinkSchema).max(32), prs: z.array(prLinkSchema).max(32),
  review: z.enum(["closed, review", "merged, verify"]).optional(),
  evidence: z.array(z.string().max(1000).refine(s => !/[\x00-\x1f\x7f]/.test(s))).max(32).optional(),
}).strict();
export type TaskLinks = z.infer<typeof taskLinksSchema>;
export type PrLink = z.infer<typeof prLinkSchema>;
export function prUrl(pr: PrLink): string { return `https://github.com/${pr.repo}/pull/${pr.number}`; }
export function parsePrLink(value: string): PrLink | undefined {
  const match = value.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:[/?#][^\s]*)?$/)
    ?? value.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/);
  if (!match) return undefined;
  const result = prLinkSchema.safeParse({ repo: match[1], number: Number(match[2]) });
  return result.success ? result.data : undefined;
}
export function uniqueLinks<T>(links: T[]): T[] { return [...new Map(links.map(link => [JSON.stringify(link), link])).values()]; }
/** Bare #N is deliberately ignored. Bare branch names need a trusted project repo. */
export function linksFromContext(context: string, projectRepo?: string): TaskLinks {
  const prs = uniqueLinks([...context.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+|(?<![\w./:@-])[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*(?![\w])/g)]
    .flatMap(m => { const pr = parsePrLink(m[0].replace(/[.,;`'")>\]]+$/, "")); return pr ? [pr] : []; }));
  const inferredRepo = projectRepo ?? (new Set(prs.map(p => p.repo)).size === 1 ? prs[0]?.repo : undefined);
  const branches: TaskLinks["branches"] = [];
  for (const match of context.matchAll(/\bbranch(?:\s*[:=]\s*|\s+)(?:`([^`]+)`|"([^"]+)"|'([^']+)'|(\S+))/gi)) {
    const token = match[1] ?? match[2] ?? match[3] ?? match[4];
    // Punctuation in bare tokens is ambiguous with prose separators. Require
    // quoting instead of ever shortening a valid Git branch name.
    if (match[4] && /[;(),`"']/.test(token)) continue;
    const at = token.indexOf("@");
    const [qualified, name] = at >= 0 ? [token.slice(0, at), token.slice(at + 1)] : [inferredRepo, token];
    const parsed = branchLinkSchema.safeParse({ repo: qualified, name });
    if (parsed.success) branches.push(parsed.data);
  }
  const distinctBranches = uniqueLinks(branches);
  // Truncation could hide an unmerged prerequisite. Oversized context needs an explicit link update.
  if (prs.length > 32 || distinctBranches.length > 32) return { version: 1, prs: [], branches: [] };
  return { version: 1, prs, branches: distinctBranches };
}
