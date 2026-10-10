import { z } from "zod";
import { git } from "./projects.js";
import { BridgeError } from "./protocol.js";

/** What find-in-files accepts: a literal or extended regular expression, the
 * usual case and whole-word switches, and optional git pathspecs to include. */
export const fileSearchSchema = z.object({
  query: z.string().min(1).max(200).refine(value => !/[\x00\n\r]/.test(value), "One line of text only."),
  regex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  include: z.array(z.string().min(1).max(200).refine(value => !value.startsWith(":") && !value.includes("\0") && !value.split("/").includes(".."), "Invalid path pattern.")).max(8).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type FileSearch = z.infer<typeof fileSearchSchema>;

const MAX_PER_FILE = 50;
const MAX_TEXT = 300;

/**
 * Find in files for the desktop editor: `git grep` over tracked and untracked
 * (not ignored) text files in the repository root the server chose, so it works
 * wherever git does and respects .gitignore. Results are grouped by file with
 * 1-based line and column; long lines are cut around the match.
 */
export async function searchRepository(root: string, input: FileSearch) {
  const limit = input.limit ?? 300;
  const args = ["grep", "-n", "--column", "-I", "--untracked", "--no-color", "--full-name", "-z",
    `--max-count=${MAX_PER_FILE}`, input.regex ? "-E" : "-F"];
  if (!input.caseSensitive) args.push("-i");
  if (input.wholeWord) args.push("-w");
  args.push("-e", input.query, "--");
  // Literal pathspecs only through glob magic, never other pathspec magic.
  // A bare pattern like "*.ts" matches in every folder, as editors expect.
  for (const pattern of input.include ?? []) args.push(`:(glob)${pattern.includes("/") ? pattern : `**/${pattern}`}`);
  let output: string;
  try {
    output = await git(root, ...args);
  } catch (error) {
    // git grep exits 1 when nothing matches; that is an empty result, not a failure.
    if (error instanceof BridgeError && error.details?.exitCode === "1" && error.details?.code === "git-failed" && /could not complete$/.test(error.message)) {
      return { matches: [], files: 0, total: 0, truncated: false };
    }
    if (error instanceof BridgeError && error.details?.code === "git-output-limit") {
      throw new BridgeError(413, "Too many matches. Narrow the search or add a path pattern.", { code: "search-too-broad" });
    }
    if (error instanceof BridgeError && /fatal: .*(regexp|regex|Invalid)/i.test(error.message)) {
      throw new BridgeError(400, "That regular expression is not valid.", { code: "search-invalid-regex" });
    }
    throw error;
  }
  const groups = new Map<string, Array<{ line: number; column: number; text: string }>>();
  let total = 0;
  let truncated = false;
  for (const row of output.split("\n")) {
    if (!row) continue;
    const [file, line, column, ...rest] = row.split("\0");
    const text = rest.join("\0");
    if (!file || !line || !column) continue;
    if (total >= limit) { truncated = true; break; }
    total += 1;
    const col = Number(column);
    // Keep the match in view when a line is long: start a little before it.
    const start = text.length > MAX_TEXT ? Math.max(0, Math.min(col - 1 - 40, text.length - MAX_TEXT)) : 0;
    const shown = text.slice(start, start + MAX_TEXT);
    const entry = { line: Number(line), column: col, text: shown, ...(start ? { offset: start } : {}) };
    const list = groups.get(file) ?? [];
    list.push(entry);
    groups.set(file, list);
  }
  return {
    matches: [...groups].map(([file, lines]) => ({ file, lines })),
    files: groups.size, total, truncated,
  };
}
