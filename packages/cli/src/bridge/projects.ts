import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { userInfo } from "node:os";
import { homeDirectory } from "./changes.js";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { phrenStoreRoot } from "./transcripts.js";
import { locateProject } from "./locate.js";
import { BridgeError, type Json } from "./protocol.js";

const exec = promisify(execFile);
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", cwd, "--no-pager", ...args], {
    timeout: 10_000, maxBuffer: 4_194_304, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" },
  })).stdout;
}
export async function gitRoot(dir: string): Promise<string | undefined> {
  try { return await realpath((await git(dir, "rev-parse", "--show-toplevel")).trim()); } catch { return undefined; }
}

/** `git status` as the app lists it: one record per file, a staged and an
 * unstaged section where each has a patch. Limited to `pathspecs` when given. */
async function statusFiles(root: string, pathspecs: string[] = []): Promise<Json[]> {
  const status = (await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", ...pathspecs.map(spec => `:(literal)${spec}`))).split("\0");
  const files: Json[] = [];
  for (let index = 0; index < status.length && files.length < 500; index++) {
    const record = status[index]; if (!record) continue;
    const code = record.slice(0, 2), file = record.slice(3);
    if (/[RC]/.test(code)) index++; // porcelain -z carries a second pathname.
    const sections: Json[] = [];
    for (const [kind, staged] of [["staged", true], ["unstaged", false]] as const) {
      if (code === "??") continue;
      const patch = await git(root, "diff", "--no-ext-diff", "--no-textconv", ...(staged ? ["--cached"] : []), "--", `:(literal)${file}`);
      if (patch) sections.push({ id: `${kind}:${file}`, kind, binary: patch.includes("Binary files"), loadState: "loaded", patch });
    }
    files.push({ path: file, status: code, sections });
  }
  return files;
}

/** The last commit that touched `pathspec` in the past half hour — what a
 * command changed when a hook (phren's own Stop hook, say) committed it before
 * anyone looked. */
async function committed(root: string, pathspec: string): Promise<Json | undefined> {
  const log = await git(root, "log", "-1", "--since=30.minutes", "--format=%h%x1f%s%x1f%cr", "-p", "--no-ext-diff", "--no-textconv", "--no-color", "--", `:(literal)${pathspec}`).catch(() => "");
  const newline = log.indexOf("\n"); if (newline < 0) return undefined;
  const [hash, subject, when] = log.slice(0, newline).split("\x1f");
  const patch = log.slice(newline + 1).replace(/^\n+/, "");
  if (!patch) return undefined;
  return { id: `committed:${pathspec}`, kind: "committed", binary: patch.includes("Binary files"), loadState: "loaded", patch, note: `${hash} · ${subject.slice(0, 120)} · ${when}` };
}

/** A path a command named, made absolute and real — `~/` expanded, relative
 * ones taken from the pane. The caller checks conversation scope after
 * resolution. Missing files resolve through their nearest existing parent so
 * a deleted file still finds its repository. */
async function resolveTouched(raw: string, cwd: string): Promise<string | undefined> {
  if (typeof raw !== "string" || !raw || raw.length > 4096 || raw.includes("\0")) return undefined;
  const home = homeDirectory();
  const absolute = raw === "~" || raw.startsWith("~/") ? path.join(home, raw.slice(1)) : path.resolve(cwd, raw);
  let existing = absolute, rest: string[] = [];
  while (!(await stat(existing).catch(() => undefined))) {
    const parent = path.dirname(existing); if (parent === existing) return undefined;
    rest.unshift(path.basename(existing)); existing = parent;
  }
  const real = path.join(await realpath(existing), ...rest);
  return real;
}

/** The pane's working tree, plus anything the command named: files in the
 * same repository that a hook already committed, and files in other
 * repositories — the phren store, a sibling checkout — grouped by root. */
export async function repositoryDiff(cwd: string, touched: unknown[] = [], allowedPaths: string[] = []): Promise<Json> {
  const root = await gitRoot(cwd);
  if (!root) throw new BridgeError(409, "This pane is not in a Git repository.");
  const allowed = (await Promise.all([root, phrenStoreRoot(), ...allowedPaths].map(raw => resolveTouched(raw, cwd)))).filter((p): p is string => !!p);
  const requested: string[] = [];
  for (const raw of touched.slice(0, 24)) {
    const file = await resolveTouched(raw as string, cwd);
    if (!file || !allowed.some(base => file === base || file.startsWith(base + path.sep))) throw new BridgeError(403, "This path is outside the conversation's recorded changes and commands.");
    requested.push(file);
  }
  const branch = (await git(root, "branch", "--show-current")).trim();
  const files = await statusFiles(root);
  const byRoot = new Map<string, string[]>();
  for (const file of requested) {
    const owner = await gitRoot((await stat(file).catch(() => undefined))?.isDirectory() ? file : path.dirname(file)); if (!owner) continue;
    // git speaks forward slashes on every platform.
    const rel = (path.relative(owner, file) || ".").split(path.sep).join("/");
    if (rel.startsWith(":")) throw new BridgeError(400, "Invalid diff pathspec.");
    const list = byRoot.get(owner) ?? []; if (!list.includes(rel)) list.push(rel); byRoot.set(owner, list);
  }
  const related: Json[] = [];
  for (const [owner, specs] of byRoot) {
    if (related.length >= 8) break;
    const listed = owner === root ? files : await statusFiles(owner, specs);
    const seen = new Set(listed.map(file => (file as { path: string }).path));
    for (const spec of specs) {
      // Uncommitted changes under the path are already listed; otherwise show the commit.
      if ([...seen].some(file => file === spec || spec === "." || file.startsWith(spec + "/"))) continue;
      const section = await committed(owner, spec);
      if (section) { listed.push({ path: spec, status: "  ", sections: [section] }); seen.add(spec); }
    }
    if (owner !== root && listed.length) related.push({ root: owner, branch: (await git(owner, "branch", "--show-current")).trim(), files: listed });
  }
  return { branch, root, launchPath: cwd, files, ...(related.length ? { related } : {}) };
}

/** The pane's current branch for the chat header. Cached briefly per
 * directory: the status stream asks every 1.5s and a branch rarely moves. */
const branches = new Map<string, { at: number; value?: string }>();
export async function repositoryBranch(cwd: string): Promise<string | undefined> {
  const cached = branches.get(cwd);
  if (cached && Date.now() - cached.at < 10_000) return cached.value;
  let value: string | undefined;
  try {
    const { stdout } = await exec("git", ["-C", cwd, "--no-pager", "branch", "--show-current"], {
      timeout: 5_000, maxBuffer: 65_536, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" },
    });
    value = stdout.trim().slice(0, 200) || undefined;
  } catch { value = undefined; }
  if (branches.size >= 64) branches.delete(branches.keys().next().value!);
  branches.set(cwd, { at: Date.now(), value });
  return value;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** Page titles arrive HTML-escaped ("Safety &amp; Quality"); show them as text. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export interface LocalServer { name: string; port: number; origin: string; process?: string; pid?: number }
function probe(port: number, host: string): Promise<string | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: string | null) => { if (!settled) { settled = true; resolve(value); } };
    const req = request({ hostname: host, port, path: "/", method: "GET", timeout: 1200, headers: { Host: `localhost:${port}` } }, res => {
      let body = "";
      res.on("data", data => { body += data.toString(); if (body.length > 32_768) res.destroy(); });
      const end = () => finish(decodeEntities(/<title[^>]*>([^<]{1,300})<\/title>/i.exec(body)?.[1] ?? "").trim() || `Web server on port ${port}`);
      res.on("end", end); res.on("close", end); res.on("error", () => finish(null));
    });
    req.on("error", () => finish(null)); req.on("timeout", () => { req.destroy(); finish(null); }); req.end();
  });
}
const LISTEN_HOST = /^(\*|127\.0\.0\.1|localhost|0\.0\.0\.0|\[::\]|\[::1\]|::|::1)$/;
/** Linux ephemeral range starts here; ports below it are far more likely to be a
 * dev server than a browser's devtools or IPC listener. */
const EPHEMERAL_PORT = 32_768;

function addListener(ports: Map<string, LocalServer>, address: string, port: number, processName?: string, pid?: number) {
  if (!LISTEN_HOST.test(address) || !Number.isInteger(port) || port <= 0) return;
  const host = address.includes(":") ? "[::1]" : "127.0.0.1";
  ports.set(`${host}:${port}`, { name: "", port, origin: `http://${host}:${port}`, process: processName, pid });
}

/** Listening TCP sockets owned by this user, via lsof (always present on macOS). */
async function listenersFromLsof(ports: Map<string, LocalServer>): Promise<void> {
  const result = await exec(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
    ["-nP", "-a", "-u", userInfo().username, "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { timeout: 4000, maxBuffer: 1_048_576 });
  let pid: number | undefined, processName: string | undefined;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (line.startsWith("c")) processName = line.slice(1);
    if (!line.startsWith("n")) continue;
    const split = line.lastIndexOf(":");
    if (split < 0) continue;
    addListener(ports, line.slice(1, split), Number(line.slice(split + 1)), processName, pid);
  }
}

/** Listening TCP sockets via iproute2's ss, which every Linux ships even when
 * lsof is absent (Arch/Omarchy, minimal containers). Lines look like
 * `LISTEN 0 512 *:3000 *:* users:(("bun",pid=123,fd=24))`. */
async function listenersFromSs(ports: Map<string, LocalServer>): Promise<void> {
  const result = await exec("ss", ["-ltnpH"], { timeout: 4000, maxBuffer: 1_048_576 });
  for (const line of result.stdout.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4) continue;
    const local = columns[3];
    const split = local.lastIndexOf(":");
    if (split < 0) continue;
    const owner = /users:\(\("([^"]*)",pid=(\d+)/.exec(line);
    addListener(ports, local.slice(0, split), Number(local.slice(split + 1)), owner?.[1], owner ? Number(owner[2]) : undefined);
  }
}

export async function webServers(): Promise<LocalServer[]> {
  const ports = new Map<string, LocalServer>();
  // Prefer ss on Linux and lsof elsewhere; try the other if the first is missing.
  const readers = process.platform === "linux" ? [listenersFromSs, listenersFromLsof] : [listenersFromLsof, listenersFromSs];
  let lastError: unknown;
  for (const reader of readers) {
    try { await reader(ports); lastError = undefined; break; } catch (error) { lastError = error; }
  }
  if (lastError && ports.size === 0) throw new BridgeError(503, "No socket listing tool found: install lsof (or iproute2's ss on Linux).");
  // Probe well-known ports first so a browser's dozens of ephemeral listeners
  // cannot push a dev server on :3000 past the cap.
  const candidates = [...ports.values()]
    .sort((a, b) => Number(a.port >= EPHEMERAL_PORT) - Number(b.port >= EPHEMERAL_PORT) || a.port - b.port)
    .slice(0, 64);
  const found: LocalServer[] = [];
  for (let i = 0; i < candidates.length; i += 8) {
    await Promise.all(candidates.slice(i, i + 8).map(async server => {
      const name = await probe(server.port, server.origin.includes("[::1]") ? "::1" : "127.0.0.1");
      if (name !== null) found.push({ ...server, name });
    }));
  }
  return found.sort((a, b) => a.port - b.port);
}

/** Launch only in real local directories under home or a locator candidate. */
export async function launchDirectory(raw: unknown, activity: Json[] = [], located: Iterable<string> = []): Promise<string> {
  if (typeof raw !== "string" || raw.length > 4096 || !path.isAbsolute(raw) || /[\x00-\x1f\x7f]/.test(raw)) throw new BridgeError(400, "Invalid workspace directory.");
  let dir: string;
  try { dir = await realpath(raw); if (!(await stat(dir)).isDirectory()) throw new Error(); }
  catch { throw new BridgeError(400, "Workspace directory does not exist."); }
  const home = await realpath(homeDirectory());
  if (dir === home || dir.startsWith(home + path.sep)) return dir;
  for (const candidate of located) {
    const real = await realpath(candidate).catch(() => undefined);
    if (real && (dir === real || dir.startsWith(real + path.sep))) return dir;
  }
  const names = [...new Set(dir.split(path.sep).filter(name => /^[a-z0-9][a-z0-9-]{0,99}$/.test(name)))];
  for (const name of names) {
    for (const candidate of await locateProject(name, activity)) {
      if (dir === candidate.directory || dir.startsWith(candidate.directory + path.sep)) return dir;
    }
  }
  throw new BridgeError(403, "Workspace directory must be under home or a located project.");
}
