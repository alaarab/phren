import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { getProjectSourcePath, readProjectConfig } from "../project-config.js";
import { projectSlugFromPath } from "../phren-paths.js";
import { errorMessage } from "../utils.js";
import { tryFileLock } from "../governance/locks.js";
import { logger } from "../logger.js";
import { languageForFile } from "./languages.js";
import { parseFile } from "./parser.js";
import {
  codeDatabasePath,
  counts,
  getMeta,
  listIndexedFiles,
  openCodeDatabase,
  purgeFile,
  replaceFileSymbols,
  replaceReferenceNames,
  resolveReferences,
  setMeta,
  upsertFileRow,
  type BlameInput,
  type IndexedFile,
  type SymbolInput,
} from "./store.js";

/**
 * Cold and incremental index of a project's tracked source files.
 *
 * The walk is `git ls-files`, so `.gitignore` is respected for free and only
 * tracked files are indexed. Files are hashed; a file whose hash is unchanged
 * is never re-parsed. Blame is stored as a sha256 of the git author line, never
 * the author's name, so nothing personal lands in the index.
 */

const MAX_FILE_BYTES = 1_500_000;

// Binary and asset files have no symbol outline worth keeping, and parsing
// them would only pad the index.
const SKIP_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "svg",
  "pdf", "wasm", "zip", "gz", "tgz", "tar", "bz2", "7z", "rar",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "mov", "m4a", "wav", "ogg", "webm", "avi",
  "sqlite", "sqlite3", "db", "lock", "bin", "dylib", "so", "dll", "exe",
  "xlsx", "xls", "docx", "pptx", "odt", "class", "jar", "o", "a",
]);

const SKIP_PATH_SEGMENTS = ["node_modules", "dist", ".git", "vendor", "third_party", "Pods"];

export interface IndexProgress {
  file: string;
  index: number;
  total: number;
}

export interface IndexOptions {
  /** Override the repository root; otherwise this machine's checkout is resolved the way locateProject resolves it. */
  repoRoot?: string;
  /** Re-parse every tracked file even when its hash is unchanged. */
  full?: boolean;
  /** Environment consulted while locating this machine's checkout ($PROJECTS_DIR); injectable for tests. */
  env?: NodeJS.ProcessEnv;
  onProgress?: (progress: IndexProgress) => void;
}

export interface IndexResult {
  project: string;
  repoRoot: string;
  databasePath: string;
  files: number;
  parsed: number;
  removed: number;
  symbols: number;
  references: number;
  durationMs: number;
}

interface BlameInfo {
  authorHash: string;
  at: string;
}

function runGit(repoRoot: string, args: string[], encoding: "utf8" | "buffer" = "utf8"): string | Buffer {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }) as string | Buffer;
}

export function isGitRepository(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, ".git")).isDirectory() || fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

export function gitTrackedFiles(repoRoot: string): string[] {
  const output = runGit(repoRoot, ["ls-files", "-z"], "buffer") as Buffer;
  return output.toString("utf8").split("\0").filter(Boolean);
}

function hasBinaryByte(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function shouldIndex(file: string): boolean {
  const lower = file.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return false;
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot + 1) : "";
  if (SKIP_EXTENSIONS.has(extension)) return false;
  const segments = file.split("/");
  return !segments.some(segment => SKIP_PATH_SEGMENTS.includes(segment));
}

const AUTHOR_HEADER = "@@phren-commit@@";
const FIELD_SEPARATOR = "\u001f";

function authorHashOf(authorLine: string): string {
  return crypto.createHash("sha256").update(authorLine).digest("hex");
}

/**
 * Last commit that touched each file, from one history walk.
 *
 * `git log` is newest-first, so the first time a path appears is its most
 * recent change. This replaces one `git blame` subprocess per file, which is
 * what makes a cold index of a real repository affordable. Author identity is
 * reduced to a hash immediately.
 */
export function collectLastCommit(repoRoot: string, wanted: ReadonlySet<string>): Map<string, BlameInfo> {
  const result = new Map<string, BlameInfo>();
  if (wanted.size === 0) return result;
  let output: string;
  try {
    output = runGit(repoRoot, ["log", "--no-merges", `--format=${AUTHOR_HEADER}%an <%ae>${FIELD_SEPARATOR}%aI`, "--name-only"]) as string;
  } catch (err: unknown) {
    logger.debug("code", `git log failed for ${repoRoot}: ${errorMessage(err)}`);
    return result;
  }
  let current: BlameInfo | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith(AUTHOR_HEADER)) {
      const parts = line.slice(AUTHOR_HEADER.length).split(FIELD_SEPARATOR);
      current = { authorHash: authorHashOf(parts[0] ?? ""), at: parts[1] ?? "" };
      continue;
    }
    if (!current) continue;
    const file = normalizeNameOnlyPath(line);
    if (!file || !wanted.has(file) || result.has(file)) continue;
    result.set(file, current);
  }
  return result;
}

/** A single file's last commit, used by the incremental path to stay fast. */
export function collectFileLastCommit(repoRoot: string, file: string): BlameInfo | undefined {
  try {
    const output = runGit(repoRoot, ["log", "-1", "--no-merges", `--format=${AUTHOR_HEADER}%an <%ae>${FIELD_SEPARATOR}%aI`, "--", file]) as string;
    const line = output.split("\n").find(entry => entry.startsWith(AUTHOR_HEADER));
    if (!line) return undefined;
    const parts = line.slice(AUTHOR_HEADER.length).split(FIELD_SEPARATOR);
    return { authorHash: authorHashOf(parts[0] ?? ""), at: parts[1] ?? "" };
  } catch (err: unknown) {
    logger.debug("code", `${file}: git log failed: ${errorMessage(err)}`);
    return undefined;
  }
}

function normalizeNameOnlyPath(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  // Renames print as "old => new" (or "{old => new}/suffix"). Take the target.
  if (trimmed.includes(" => ")) {
    return trimmed.replace(/\{([^}]*?) => ([^}]*?)\}/g, "$2").split(" => ").pop()!.replace(/\{|\}/g, "").trim();
  }
  return trimmed;
}

// The roots locateProject offers for a project's checkout on this computer
// (bridge/locate.ts), minus its Hook-only activity journal and Herdr session.
const SEARCH_ROOTS = ["", "Sites", "Projects", "projects", "Code", "code", "dev", "src", "repos", "workspace"];

/**
 * This machine's candidates for a project's checkout, in locateProject's
 * order: the store's registered source path when it points at a folder that
 * exists here, then a folder named for the project under $PROJECTS_DIR and
 * the usual project roots. A sourcePath written on another computer (the
 * Linux box a shared store was registered on) fails the existence check and
 * the machine's own checkout is offered instead.
 */
function machineCheckoutCandidates(project: string, sourcePath: string | undefined, env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const offer = (directory: string) => {
    const resolved = path.resolve(directory);
    if (!candidates.includes(resolved) && fs.existsSync(resolved)) candidates.push(resolved);
  };
  if (sourcePath) offer(sourcePath);
  const home = homedir();
  for (const root of [...(env.PROJECTS_DIR ? [env.PROJECTS_DIR] : []), ...SEARCH_ROOTS.map(entry => path.join(home, entry))]) {
    offer(path.join(root, project));
  }
  return candidates;
}

/**
 * The repository an index runs against: the --repo override when given,
 * otherwise this machine's checkout (registered source path if it exists
 * here, then the usual project roots), otherwise the store's recorded
 * sourcePath so the error still names what the store knows, otherwise the
 * working directory. Among the machine candidates the first git repository
 * wins, since the index can only walk a repository.
 */
export function resolveRepoRoot(store: string, project: string, override?: string, env: NodeJS.ProcessEnv = process.env): string {
  let repoRoot: string;
  if (override) {
    repoRoot = path.resolve(override);
  } else {
    const sourcePath = getProjectSourcePath(store, project, readProjectConfig(store, project));
    const candidates = machineCheckoutCandidates(project, sourcePath, env);
    repoRoot = candidates.find(candidate => isGitRepository(candidate))
      ?? candidates[0]
      ?? sourcePath
      ?? path.resolve(process.cwd());
  }
  if (!fs.existsSync(repoRoot)) throw new Error(`Code index: repository path does not exist: ${repoRoot}`);
  if (!isGitRepository(repoRoot)) throw new Error(`Code index: not a git repository: ${repoRoot}`);
  return repoRoot;
}

export function defaultProjectForCwd(cwd: string = process.cwd()): string {
  return projectSlugFromPath(cwd) || "project";
}

function blameForFile(repoRoot: string, file: string, symbols: SymbolInput[], cached?: BlameInfo): BlameInput[] {
  const info = cached ?? collectFileLastCommit(repoRoot, file);
  if (!info) return [];
  return symbols.map(symbol => ({ line: symbol.line, authorHash: info.authorHash, at: info.at }));
}

/**
 * Index (or re-index) one project. Incremental by file hash; `full` forces a
 * re-parse of every tracked file.
 */
export async function indexProject(store: string, project: string, options: IndexOptions = {}): Promise<IndexResult> {
  const release = tryFileLock(codeDatabasePath(store, project));
  if (!release) throw new Error(`Code index: an index is already running for ${project}.`);
  try { return await indexProjectLocked(store, project, options); } finally { release(); }
}

async function indexProjectLocked(store: string, project: string, options: IndexOptions): Promise<IndexResult> {
  const started = Date.now();
  const repoRoot = resolveRepoRoot(store, project, options.repoRoot, options.env);
  const database = await openCodeDatabase(store, project, true);
  if (!database) throw new Error(`Code index: could not open the index for ${project}.`);
  const { db } = database;
  try {

    // Remember which checkout this index came from so read-side queries can
    // return a definition's source snippet even when the index was built with
    // `--repo` against a path the project does not register.
    const previousRoot = getMeta(db, "repo_root");
    const rootChanged = previousRoot !== repoRoot;
    const needsReferenceNames = getMeta(db, "reference_names_version") !== "1";
    if (rootChanged) setMeta(db, "repo_root", repoRoot);

    let existing: Map<string, IndexedFile>;
    try {
      existing = listIndexedFiles(db);
    } catch (err: unknown) {
      logger.debug("code", `index metadata unreadable, rebuilding: ${errorMessage(err)}`);
      existing = new Map();
    }

    const tracked = gitTrackedFiles(repoRoot).filter(shouldIndex);
    const currentPaths = new Set<string>();
    const pending: Array<{ file: string; hash: string; language: string; mtime: number; source: string }> = [];

    for (const file of tracked) {
      const full = path.join(repoRoot, file);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;

      let source: string;
      try {
        const buffer = fs.readFileSync(full);
        if (hasBinaryByte(buffer)) continue;
        source = buffer.toString("utf8");
      } catch (err: unknown) {
        logger.debug("code", `read failed for ${file}: ${errorMessage(err)}`);
        continue;
      }
      currentPaths.add(file);
      const hash = crypto.createHash("sha256").update(source).digest("hex");
      if (!options.full && !rootChanged && !needsReferenceNames && existing.get(file)?.hash === hash) continue;

      pending.push({ file, hash, language: languageForFile(file)?.name ?? "unknown", mtime: Math.floor(stat.mtimeMs), source });
    }

    const vanished = [...existing.keys()].filter(file => !currentPaths.has(file));
    const changed = pending.map(entry => entry.file);
    const blame = new Map<string, BlameInfo>();
    if (changed.length > 0 && changed.length <= 24) {
      for (const file of changed) {
        const info = collectFileLastCommit(repoRoot, file);
        if (info) blame.set(file, info);
      }
    } else {
      for (const [file, info] of collectLastCommit(repoRoot, new Set(changed))) blame.set(file, info);
    }

    let parsedCount = 0;
    db.run("BEGIN");
    try {
      let done = 0;
      for (const entry of pending) {
        let result;
        try {
          result = await parseFile(entry.file, entry.source);
        } catch (err: unknown) {
          logger.debug("code", `parse failed for ${entry.file}: ${errorMessage(err)}`);
          continue;
        }
        const symbols: SymbolInput[] = result.symbols.map(symbol => ({
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line,
          endLine: symbol.endLine,
          signature: symbol.signature,
          doc: symbol.doc,
          parent: symbol.parent,
          exported: symbol.exported,
        }));
        replaceFileSymbols(db, entry.file, symbols, blameForFile(repoRoot, entry.file, symbols, blame.get(entry.file)));
        replaceReferenceNames(db, entry.file, result.references);
        upsertFileRow(db, { path: entry.file, hash: entry.hash, language: entry.language, mtime: entry.mtime });
        parsedCount += 1;
        done += 1;
        options.onProgress?.({ file: entry.file, index: done, total: pending.length });
      }

      for (const file of vanished) purgeFile(db, file);

      if (parsedCount > 0 || vanished.length > 0) resolveReferences(db);
      if (parsedCount === pending.length) setMeta(db, "reference_names_version", "1");
      db.run("COMMIT");
    } catch (err) {
      try { db.run("ROLLBACK"); } catch { /* the transaction may already be closed */ }
      throw err;
    }

    // Nothing parsed and nothing vanished means the database on disk is already
    // current; skip the export and write.
    if (parsedCount > 0 || vanished.length > 0 || rootChanged || needsReferenceNames) database.persist();
    const totals = counts(db);

    return {
      project,
      repoRoot,
      databasePath: codeDatabasePath(store, project),
      files: currentPaths.size,
      parsed: parsedCount,
      removed: vanished.length,
      symbols: totals.symbols,
      references: totals.references,
      durationMs: Date.now() - started,
    };
  } finally { database.close(); }
}
