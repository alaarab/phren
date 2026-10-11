import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BridgeError, type Json } from "./protocol.js";
import { git, gitRoot, withGitReadDeadline } from "./projects.js";
import { invalidateTree, repositoryPath } from "./git.js";
import type { ChangedFile } from "./changes.js";

/** What a review screen needs beyond status and patches: a file's text at
 * HEAD, in the index or at a commit (so a real diff editor can compare whole
 * files), staging or unstaging single hunks, and the edits one agent session
 * made. */

const MAX_FILE = 2_000_000;
const MAX_PATCH = 2_000_000;

async function repository(cwd: string): Promise<string> {
  const root = await gitRoot(cwd);
  if (!root) throw new BridgeError(409, "This pane is not in a Git repository.", { code: "git-not-repository" });
  return root;
}

/** `HEAD`, `INDEX` (stage 0) or a commit hash. */
function revision(raw: unknown): string {
  if (raw === "HEAD" || raw === "INDEX") return raw;
  if (typeof raw === "string" && /^[0-9a-fA-F]{4,64}$/.test(raw)) return raw;
  throw new BridgeError(400, "Name HEAD, INDEX or a commit hash.");
}

/** One file's text at HEAD, in the index or at a commit. A path the tree does
 * not hold answers `missing: true` (an added or deleted side), a file larger
 * than 2 MB `tooLarge: true`, and bytes with a NUL `binary: true`, each with
 * no text. */
export function gitFile(cwd: string, ref: unknown, rawPath: unknown): Promise<Json> {
  return withGitReadDeadline(async () => {
    const root = await repository(cwd);
    const rev = revision(ref);
    const file = await repositoryPath(root, rawPath);
    let spec: string;
    if (rev === "INDEX") spec = `:0:${file}`;
    else {
      let commit: string;
      try { commit = (await git(root, "rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`)).trim(); }
      catch { throw new BridgeError(404, "This repository has no such commit.", { code: "git-unknown-commit" }); }
      spec = `${commit}:${file}`;
    }
    const kind = await git(root, "cat-file", "-t", spec).then(out => out.trim(), () => "");
    if (!kind) return { path: file, ref: rev, missing: true, text: "" };
    if (kind !== "blob") return { path: file, ref: rev, missing: true, text: "", kindOf: kind };
    const size = Number((await git(root, "cat-file", "-s", spec)).trim()) || 0;
    if (size > MAX_FILE) return { path: file, ref: rev, size, tooLarge: true, text: "" };
    const text = await git(root, "cat-file", "blob", spec);
    if (text.slice(0, 8000).includes("\0")) return { path: file, ref: rev, size, binary: true, text: "" };
    return { path: file, ref: rev, size, text };
  });
}

/** A name in a patch header: `a/x` or a C-quoted `"a/x\ty"`. */
function headerName(raw: string): string | null {
  let name = raw.trim();
  if (name === "/dev/null") return null;
  if (name.startsWith("\"")) {
    try { name = JSON.parse(name); } catch { throw new BridgeError(400, "This patch names a file Phren cannot read."); }
  }
  if (!/^[ab]\//.test(name)) throw new BridgeError(400, "This patch is not a Git patch.");
  return name.slice(2);
}

/** The files a patch touches, from its `---`/`+++` lines. Rename, mode and
 * binary patches are refused: only text hunks are staged one at a time. */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  let hunks = 0;
  for (const line of patch.split("\n")) {
    if (/^(?:rename|copy) (?:from|to) |^(?:old|new|deleted file|new file) mode |^GIT binary patch|^Binary files /.test(line)) {
      throw new BridgeError(400, "Only text hunks can be staged one at a time. Stage the whole file instead.");
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const name = headerName(line.slice(4).replace(/\t.*$/, ""));
      if (name) files.add(name);
    }
    if (line.startsWith("@@ ")) hunks++;
  }
  if (!files.size || !hunks) throw new BridgeError(400, "This patch has no hunks.");
  if (files.size > 1) throw new BridgeError(400, "Stage hunks of one file at a time.");
  return [...files];
}

/** Apply a patch of one file's hunks to the index only: staging them, or with
 * `reverse` unstaging them. The working tree is never touched. Git checks the
 * patch first; a hunk that no longer applies (the file moved on) is Git's
 * refusal as `{ ok: false, output }`. */
export async function gitApply(cwd: string, rawPatch: unknown, reverse: unknown): Promise<Json> {
  if (typeof rawPatch !== "string" || !rawPatch.trim()) throw new BridgeError(400, "Choose a hunk to stage.");
  if (rawPatch.length > MAX_PATCH || rawPatch.includes("\0")) throw new BridgeError(400, "This patch is too large.");
  const root = await repository(cwd);
  const [file] = patchFiles(rawPatch);
  await repositoryPath(root, file);
  const scratch = await mkdtemp(path.join(tmpdir(), "phren-apply-"));
  const patchFile = path.join(scratch, "hunk.patch");
  try {
    await writeFile(patchFile, rawPatch.endsWith("\n") ? rawPatch : rawPatch + "\n", { mode: 0o600 });
    const args = ["apply", "--cached", "--whitespace=nowarn", ...(reverse === true ? ["-R"] : []), "--", patchFile];
    invalidateTree(root);
    try { await git(root, "apply", "--check", ...args.slice(1)); }
    catch (error) {
      return { ok: false, output: error instanceof BridgeError ? error.message.replace(/^Git apply failed: /, "") : "git apply refused this hunk." };
    }
    await git(root, ...args);
    return { ok: true, path: file, staged: reverse !== true };
  } finally {
    invalidateTree(root);
    await rm(scratch, { recursive: true, force: true });
  }
}

/** One session's recorded edits, oldest first, folded by file: how often each
 * file changed, the lines added and removed across those edits, and each
 * edit's patch. Only edits inside `root` (the session's repository) count;
 * `others` says how many touched other repositories. */
export function sessionChanges(root: string, history: { toolUseId: string; files: ChangedFile[] }[]): Json {
  const files = new Map<string, { path: string; status: string; added: number; removed: number; edits: Json[]; redacted: boolean; binary: boolean }>();
  let others = 0, calls = 0;
  for (const row of history) {
    let counted = false;
    for (const change of row.files) {
      if (change.root !== root) { others++; continue; }
      counted = true;
      const entry = files.get(change.path) ?? { path: change.path, status: change.status, added: 0, removed: 0, edits: [], redacted: false, binary: false };
      entry.added += change.added; entry.removed += change.removed;
      entry.redacted ||= change.redacted === true; entry.binary ||= change.binary === true;
      // The first edit's status says whether the session added the file.
      if (entry.edits.length && change.status === "D") entry.status = "D";
      if (entry.edits.length < 50) entry.edits.push({ toolUseId: row.toolUseId, status: change.status, added: change.added, removed: change.removed,
        patch: change.patch.slice(0, 200_000), ...(change.patch.length > 200_000 || change.truncated ? { truncated: true } : {}) });
      files.delete(change.path); files.set(change.path, entry);
    }
    if (counted) calls++;
  }
  const list = [...files.values()].reverse().slice(0, 300);
  return { root, calls, files: list, totalFiles: files.size, others,
    additions: list.reduce((n, f) => n + f.added, 0), deletions: list.reduce((n, f) => n + f.removed, 0) };
}
