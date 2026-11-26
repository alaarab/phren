import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bridgeRoot, socketPath } from "./protocol.js";
import { health } from "./transport.js";

const exec = promisify(execFile);
interface VersionDirectory { version: string; file: string; ino: number; dev: number; mtimeMs: number }
export interface HookVersionPrunePlan {
  versions: string;
  canonical?: string;
  current?: string;
  keep: Record<string, string[]>;
  delete: (VersionDirectory & { bytes: number })[];
  bytes: number;
  error?: string;
}

async function optionalMetadata(file: string) {
  try { return await lstat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Build a read-only plan: no payload reads, file changes or logging. */
export async function planHookVersionPrune(): Promise<HookVersionPrunePlan> {
  const root = bridgeRoot(), versions = path.join(root, "versions");
  const plan: HookVersionPrunePlan = { versions, keep: {}, delete: [], bytes: 0 };
  const entries: VersionDirectory[] = [];
  const keep = (version: string, reason: string) => { (plan.keep[version] ??= []).push(reason); };
  try {
    if (!(await lstat(versions)).isDirectory()) throw new Error("versions is not a directory");
    plan.canonical = await realpath(versions);
    for (const version of await readdir(versions)) {
      const file = path.join(versions, version), metadata = await lstat(file);
      if (metadata.isDirectory()) entries.push({ version, file, ino: metadata.ino, dev: metadata.dev, mtimeMs: metadata.mtimeMs });
    }
    plan.current = await realpath(path.join(root, "current"));
    if (path.dirname(plan.current) !== plan.canonical || !entries.some(entry => path.join(plan.canonical!, entry.version) === plan.current)) {
      throw new Error("current does not resolve to a version directory");
    }
    const current = path.basename(plan.current);
    keep(current, "current");
    // Directory mtime records install time, unlike dev/security version names which do not sort chronologically.
    const others = entries.filter(entry => entry.version !== current).sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of others.slice(0, 2)) keep(entry.version, "one of the two newest other versions by directory mtime");

    // One Hook owns the root's socket; an uncertain running version keeps everything.
    const socket = await optionalMetadata(socketPath());
    if (socket) {
      if (!socket.isSocket()) throw new Error("unexpected Hook socket entry");
      const running = (await health()).version;
      if (typeof running !== "string" || !entries.some(entry => entry.version === running)) throw new Error("unknown running Hook version");
      keep(running, "running Hook");
    }

    // install.ts writes these four scripts (askpass through installAskpass); start.sh is a legacy launcher.
    const artifacts = [
      ...["dispatch", "dispatch-scoped", "enroll", "askpass", "start.sh"].map(name => path.join(root, name)),
      path.join(homedir(), "Library/LaunchAgents/com.phren.hook.plist"),
      path.join(homedir(), ".config/systemd/user/phren-hook.service"),
    ];
    for (const file of artifacts) {
      const metadata = await optionalMetadata(file);
      if (!metadata) continue;
      if (!metadata.isFile() || metadata.size > 1_048_576) throw new Error("unexpected launch artifact");
      const text = await readFile(file, "utf8");
      for (const entry of entries) {
        const escaped = entry.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`versions/${escaped}(?=[/"'\\s]|$)`).test(text)) keep(entry.version, `launch artifact: ${file}`);
      }
    }

    for (const entry of others) {
      if (plan.keep[entry.version]) continue;
      // du counts allocated bytes from metadata without reading payloads or following symlinks.
      const { stdout } = await exec("du", ["-sk", entry.file], { timeout: 30_000, maxBuffer: 4096 });
      const match = /^(\d+)\s/.exec(stdout);
      const bytes = match ? Number(match[1]) * 1024 : NaN;
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("could not measure a version directory");
      plan.delete.push({ ...entry, bytes });
      plan.bytes += bytes;
    }
  } catch (error) {
    plan.error = `Version inspection failed${(error as NodeJS.ErrnoException).code ? ` (${(error as NodeJS.ErrnoException).code})` : ""}`;
    for (const entry of entries) keep(entry.version, "kept because inspection could not finish safely");
    plan.delete = []; plan.bytes = 0;
  }
  return plan;
}

/** Best-effort execution, called only after the entire installation succeeds. */
export async function pruneHookVersions(): Promise<{ removed: number; bytes: number }> {
  let removed = 0, bytes = 0, incomplete = false;
  try {
    const plan = await planHookVersionPrune();
    incomplete = plan.error !== undefined;
    for (const entry of plan.delete) {
      // Recheck current and directory identity immediately before every removal.
      if (!(await lstat(plan.versions)).isDirectory() || await realpath(plan.versions) !== plan.canonical || await realpath(path.join(bridgeRoot(), "current")) !== plan.current) {
        incomplete = true; break;
      }
      const metadata = await lstat(entry.file);
      if (!metadata.isDirectory() || metadata.ino !== entry.ino || metadata.dev !== entry.dev) { incomplete = true; break; }
      await rm(entry.file, { recursive: true });
      removed++; bytes += entry.bytes;
    }
  } catch { incomplete = true; }
  console.log(`Hook versions: removed ${removed} version(s), freed ${bytes} bytes.${incomplete ? " Some versions were kept because cleanup could not finish safely." : ""}`);
  return { removed, bytes };
}
