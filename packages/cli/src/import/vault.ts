import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLock } from "../governance/locks.js";
import { parseSkillFrontmatter } from "../link/skills.js";
import { isRecord } from "../phren-core.js";
import { atomicWriteText, runtimeFile } from "../phren-paths.js";

const MAX_NOTE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * MAX_NOTE_BYTES;
const EXPORT_MANIFEST = ".phren-vault.json";
const IMPORT_MANIFEST = ".phren-import.json";
const IGNORED_DIRS = new Set([".obsidian", ".trash", ".git", "attachments"]);
const INDEXED_DIR_ESCAPE = /^(?:notes|skills|node_modules|dist|build)$/i;
const DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³]) *(?:\.|$)/i;
const UNSAFE_NAME = /[<>:"/\\|?*\p{Cc}]/gu;
const SHA256 = /^[a-f0-9]{64}$/;
const EXPORTED_NOTE = /^(?:finding|fragment|project)-[a-z0-9_-]{1,200}\.md$/;

interface ImportedNote {
  path: string;
  sha256: string;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function portableName(name: string, note = false): string {
  const stem = note ? name.slice(0, -3) : name;
  // Keep paths visible to the default indexer and portable to Windows.
  let safe = stem.replaceAll(UNSAFE_NAME, "_").replace(/[ .]+$/, "");
  if (!safe || safe.startsWith(".") || DEVICE_NAME.test(safe)
    || (note ? /^(?:agents|claude)$/i.test(safe) : INDEXED_DIR_ESCAPE.test(safe))) safe = `_${safe}`;
  if (Buffer.byteLength(safe) > 160) safe = `${note ? "note" : "folder"}-${digest(stem).slice(0, 12)}`;
  return note ? `${safe}.md` : safe;
}

function statIfPresent(file: string): fs.Stats | undefined {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

function realpathWithin(root: string, file: string): string {
  const resolved = fs.realpathSync.native(file);
  if (!contains(root, resolved)) throw new Error(`Path escapes the import root: ${file}`);
  return resolved;
}

function checkedPath(root: string, relative: string, file = false): string {
  const parts = relative.split("/");
  if (parts.some(part => !part || part.startsWith(".") || /[ .]$/.test(part)
    || part.search(UNSAFE_NAME) >= 0 || DEVICE_NAME.test(part) || Buffer.byteLength(part) > 180)) {
    throw new Error(`Unsafe import path ${JSON.stringify(relative)}`);
  }
  let target = root;
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    const stat = statIfPresent(target);
    if (stat && !(file && index === parts.length - 1 ? stat.isFile() : stat.isDirectory())) {
      throw new Error(`Unexpected file type at ${target}`);
    }
    if (stat) target = realpathWithin(root, target);
  }
  return target;
}

function readBounded(root: string, file: string, stat: fs.Stats, limit: number): Buffer | undefined {
  if (!stat.isFile()) throw new Error(`Expected a regular file at ${file}`);
  if (stat.size > limit) return undefined;
  const fd = fs.openSync(realpathWithin(root, file), "r");
  try {
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) return bytes.subarray(0, offset);
      offset += count;
    }
    if (offset > limit) return undefined;
    throw new Error(`File grew during vault import: ${file}`);
  } finally {
    fs.closeSync(fd);
  }
}

function noteDigest(root: string, file: string, stat = statIfPresent(file)): string | undefined {
  const bytes = stat?.isFile() ? readBounded(root, file, stat, MAX_NOTE_BYTES) : undefined;
  return bytes && digest(bytes);
}

function readManifest(root: string, file: string): unknown {
  const stat = statIfPresent(file);
  if (!stat) return undefined;
  const bytes = readBounded(root, file, stat, MAX_MANIFEST_BYTES);
  if (!bytes) throw new Error(`Manifest exceeds 8 MiB: ${file}`);
  try {
    return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Invalid vault manifest at ${file}`);
  }
}

function exportHashes(vault: string): Map<string, Set<string>> {
  const data = readManifest(vault, path.join(vault, EXPORT_MANIFEST));
  const hashes = new Map<string, Set<string>>();
  if (data === undefined) return hashes;
  const validMap = (value: unknown): value is Record<string, string> => isRecord(value)
    && Object.entries(value).every(([name, hash]) => EXPORTED_NOTE.test(name) && typeof hash === "string" && SHA256.test(hash));
  if (!isRecord(data) || data.version !== 1 || !validMap(data.files) || (data.pending !== undefined && !validMap(data.pending))) {
    throw new Error(`Invalid export manifest in ${EXPORT_MANIFEST}`);
  }
  for (const [name, hash] of Object.entries(data.files)) hashes.set(name, new Set([hash]));
  for (const [name, hash] of Object.entries(data.pending ?? {})) {
    const previous = hashes.get(name);
    if (previous) previous.add(hash); else hashes.set(name, new Set([hash]));
  }
  return hashes;
}

function generatedNote(bytes: Buffer): boolean {
  return parseSkillFrontmatter(bytes.toString("utf8")).frontmatter?.phren === "generated";
}

function contains(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

function importNotes(vault: string, project: string, prefix: string, options: { dryRun: boolean; prune: boolean }) {
  const root = checkedPath(project, prefix);
  const manifestPath = path.join(root, IMPORT_MANIFEST);
  const previous = readManifest(root, manifestPath);
  if (previous !== undefined && (!isRecord(previous) || (previous.version !== 1 && previous.version !== 2)
    || !isRecord(previous.files) || (previous.pending !== undefined && !isRecord(previous.pending)))) {
    throw new Error(`Invalid import manifest at ${manifestPath}`);
  }
  const tracked = new Map<string, ImportedNote>();
  const mapped = new Map<string, string>();
  const occupied = new Map<string, string>();
  const scannedParents = new Set<string>();
  const pathKey = (rel: string) => rel.normalize("NFC").toLowerCase();
  function reserve(source: string, dest: string) {
    const key = pathKey(dest);
    const owner = occupied.get(key);
    if ((owner !== undefined && owner !== source) || (mapped.has(source) && mapped.get(source) !== dest)) {
      throw new Error(`Conflicting import path ${JSON.stringify(dest)}`);
    }
    occupied.set(key, source);
    mapped.set(source, dest);
  }

  // Only digests of completed copies establish ownership, including a matching pending copy.
  for (const key of ["files", "pending"] as const) {
    for (const [source, entry] of Object.entries(previous?.version === 2 ? (previous[key] ?? {}) as Record<string, unknown> : {})) {
      const srcParts = source.split("/");
      if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)
        || !/\.md$/i.test(source) || !entry.path.endsWith(".md") || srcParts.length !== entry.path.split("/").length) {
        throw new Error(`Invalid import manifest entry ${JSON.stringify(source)}`);
      }
      const { path: dest, sha256 } = entry;
      const file = checkedPath(project, `${prefix}/${dest}`, true);
      let completed = true;
      if (key === "pending") {
        const old = tracked.get(source);
        if (old && old.path !== dest) throw new Error(`Conflicting import paths for ${JSON.stringify(source)}`);
        const stat = statIfPresent(file);
        completed = !!stat && noteDigest(root, file, stat) === sha256;
        if (stat && !completed) continue;
      }
      const destParts = dest.split("/");
      for (let depth = 1; depth < srcParts.length; depth++) {
        reserve(`${srcParts.slice(0, depth).join("/")}/`, destParts.slice(0, depth).join("/"));
      }
      reserve(source, dest);
      if (completed) tracked.set(source, { path: dest, sha256 });
    }
  }

  function destination(source: string, parent: string, name: string, note: boolean): string {
    const prior = mapped.get(source);
    if (prior !== undefined) return prior;
    const base = parent ? `${parent}/` : "";
    if (!scannedParents.has(parent)) {
      const dir = parent ? checkedPath(project, `${prefix}/${parent}`) : root;
      const stat = statIfPresent(dir);
      if (stat?.isDirectory()) {
        for (const entry of fs.readdirSync(realpathWithin(root, dir))) {
          const key = pathKey(base + entry);
          if (!occupied.has(key)) occupied.set(key, "");
        }
      }
      scannedParents.add(parent);
    }
    const safe = portableName(name, note);
    let dest = base + safe;
    for (let attempt = 0; occupied.has(pathKey(dest)); attempt++) {
      const suffix = digest(attempt ? `${source}\0${attempt}` : source).slice(0, 12);
      dest = base + (note ? `${safe.slice(0, -3)}~${suffix}.md` : `${safe}~${suffix}`);
    }
    reserve(source, dest);
    return dest;
  }

  const exported = exportHashes(vault);
  const missing = new Set(tracked.keys());
  const oversized: string[] = [];
  const conflicts: string[] = [];
  const writes: Array<{ source: string; copy: ImportedNote; expected?: string }> = [];
  const removals: Array<{ file: string; sha256: string }> = [];
  const forget: string[] = [];
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let generated = 0;
  function visit(folder: string, output: string): void {
    const dir = realpathWithin(vault, path.join(vault, folder));
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      const source = folder ? `${folder}/${name}` : name;
      const file = path.join(vault, source);
      const stat = statIfPresent(file);
      if (stat?.isSymbolicLink()) {
        for (const prior of missing) if (prior === source || prior.startsWith(`${source}/`)) missing.delete(prior);
      } else if (stat?.isDirectory()) {
        if (!IGNORED_DIRS.has(name.toLowerCase())) visit(source, destination(`${source}/`, output, name, false));
      } else if (stat?.isFile() && /\.md$/i.test(name)) {
        missing.delete(source);
        const bytes = readBounded(vault, file, stat, MAX_NOTE_BYTES);
        if (!bytes) { oversized.push(source); continue; }
        const sha256 = digest(bytes);
        if (exported.get(source)?.has(sha256) || generatedNote(bytes)) { generated++; continue; }
        const dest = destination(source, output, name, true);
        const outputFile = checkedPath(project, `${prefix}/${dest}`, true);
        let expected: string | undefined;
        const outputStat = statIfPresent(outputFile);
        if (outputStat) {
          expected = tracked.get(source)?.sha256;
          if (!expected || noteDigest(root, outputFile, outputStat) !== expected) { conflicts.push(dest); continue; }
          if (expected === sha256) { unchanged++; continue; }
          updated++;
        } else {
          added++;
        }
        writes.push({ source, copy: { path: dest, sha256 }, expected });
      }
    }
  }
  visit("", "");

  if (options.prune) for (const source of missing) {
    const { path: dest, sha256 } = tracked.get(source)!;
    const file = checkedPath(project, `${prefix}/${dest}`, true);
    const stat = statIfPresent(file);
    if (stat) {
      if (noteDigest(root, file, stat) !== sha256) { conflicts.push(dest); continue; }
      removals.push({ file, sha256 });
    }
    forget.push(source);
  }

  const encode = (files: Map<string, ImportedNote>, pending?: Record<string, ImportedNote>) => {
    const bytes = Buffer.from(`${JSON.stringify({ version: 2, files: Object.fromEntries(files), pending }, null, 2)}\n`);
    if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("Import manifest exceeds 8 MiB");
    return bytes;
  };
  const pending = writes.length ? encode(tracked, Object.fromEntries(writes.map(({ source, copy }) => [source, copy]))) : undefined;
  for (const { source, copy } of writes) tracked.set(source, copy);
  for (const source of forget) tracked.delete(source);
  const completed = encode(tracked);
  if (!options.dryRun && (pending || forget.length || previous?.pending !== undefined)) {
    if (pending) atomicWriteText(manifestPath, pending);
    for (const { source, copy, expected } of writes) {
      const input = path.join(vault, source);
      const stat = statIfPresent(input);
      const bytes = stat && readBounded(vault, input, stat, MAX_NOTE_BYTES);
      if (!bytes || digest(bytes) !== copy.sha256) throw new Error(`Note changed during vault import: ${input}`);
      const file = checkedPath(project, `${prefix}/${copy.path}`, true);
      const current = statIfPresent(file);
      if (expected === undefined ? current : noteDigest(root, file, current) !== expected) {
        throw new Error(`Copy changed during vault import: ${file}`);
      }
      atomicWriteText(file, bytes);
    }
    for (const { file, sha256 } of removals) {
      if (noteDigest(root, file) !== sha256) throw new Error(`Copy changed during vault import: ${file}`);
      fs.unlinkSync(file);
    }
    atomicWriteText(manifestPath, completed);
  }
  const addedPaths = writes.filter(write => write.expected === undefined).map(write => write.copy.path);
  return { added, addedPaths, updated, unchanged, generated, oversized, missing: [...missing], pruned: removals.length, conflicts, root };
}

export function importVault(directory: string, projectDir: string, options: { dryRun: boolean; prune: boolean }) {
  const vault = fs.realpathSync.native(directory);
  if (!fs.statSync(vault).isDirectory()) throw new Error(`Expected a vault directory at ${directory}`);
  if (!statIfPresent(projectDir)?.isDirectory()) throw new Error(`Expected a project directory at ${projectDir}`);
  const project = fs.realpathSync.native(projectDir);
  const name = `${portableName(path.basename(vault) || "vault")}-${digest(vault).slice(0, 12)}`;
  const prefix = `reference/obsidian/${name}`;
  const root = checkedPath(project, prefix);
  if (contains(vault, root) || contains(root, vault)) throw new Error("Vault and import destination must be separate directories");
  const run = () => importNotes(vault, project, prefix, options);
  if (options.dryRun) return run();
  const lock = runtimeFile(path.dirname(project), `vault-import-${digest(`${project}\0${vault}`).slice(0, 12)}`);
  const lockStat = statIfPresent(`${lock}.lock`);
  if (lockStat && !lockStat.isFile()) throw new Error(`Unexpected import lock at ${lock}.lock`);
  return withFileLock(lock, run);
}
