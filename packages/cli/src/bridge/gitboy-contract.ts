import { z } from "zod";

// The grammar gitboy's routes accept, shared by the scoped SSH gateway (which
// refuses anything else before the Hook sees it) and the Hook routes (which
// apply it again for every other caller). Kept free of node and store imports
// so the gateway stays cheap to start.

export const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,99}$/;
export const FINDING_TYPE_VALUES = ["decision", "pitfall", "pattern", "bug"] as const;

export const MAX_FILE_PATHS = 500;
export const MAX_SEARCH_QUERY = 1000;
export const MAX_SEARCH_LIMIT = 20;
export const MAX_FINDING_BODY = 8192;
export const MAX_FINDING_TEXT = 5000;

/** A repository-relative path: `/`-separated segments of ordinary file-name
 * characters, no empty, `.` or `..` segment, no leading `/`, at most 1024. */
export function isRepoPath(value: string): boolean {
  if (value.length < 1 || value.length > 1024) return false;
  if (!/^[A-Za-z0-9 ._@+~,=()[\]{}#!$&'-]+(?:\/[A-Za-z0-9 ._@+~,=()[\]{}#!$&'-]+)*$/.test(value)) return false;
  return value.split("/").every(segment => segment !== "." && segment !== ".." && segment.trim() === segment);
}

/** A branch as git allows it, narrowed: no `..`, `@{`, leading `-` or `/`,
 * trailing `/`, `.lock` or `.`, at most 200 characters. */
export function isBranchName(value: string): boolean {
  if (!/^[A-Za-z0-9._\/+-]{1,200}$/.test(value)) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  return !value.includes("..") && !value.includes("//") && !value.split("/").some(part => part.startsWith("."));
}

/** Search text: an error excerpt may carry tabs and newlines, nothing else below space. */
export function isSearchText(value: string): boolean {
  return value.trim().length > 0 && value.length <= MAX_SEARCH_QUERY && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
}

const noControls = (value: string) => !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);

export const findingWriteSchema = z.object({
  text: z.string().max(MAX_FINDING_TEXT).refine(noControls, "Text may contain tabs and newlines but no other control characters.")
    .transform(value => value.replace(/\s+/g, " ").trim()).refine(value => value.length > 0, "Text is empty."),
  type: z.enum(FINDING_TYPE_VALUES).optional(),
  citation: z.object({
    file: z.string().refine(isRepoPath, "citation.file must be a repository-relative path.").optional(),
    line: z.number().int().min(1).max(10_000_000).optional(),
    commit: z.string().regex(/^[0-9a-fA-F]{7,64}$/).optional(),
    name: z.string().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional(),
  }).strict().optional(),
}).strict();
export type FindingWrite = z.infer<typeof findingWriteSchema>;
