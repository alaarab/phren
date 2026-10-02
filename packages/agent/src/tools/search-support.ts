import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

/** Longest line the search tools hand back; one minified file must not flood context. */
export const MAX_LINE_CHARS = 500;

export function capLine(text: string, max = MAX_LINE_CHARS): string {
  return text.length > max ? `${text.slice(0, max)} ...[${text.length - max} more chars]` : text;
}

let rgCache: string | null | undefined;

/**
 * Absolute path of ripgrep, or null when it is not on PATH or
 * `PHREN_AGENT_RIPGREP=off` forces the JS walker. The PATH scan runs once.
 */
export function ripgrepPath(): string | null {
  if (process.env.PHREN_AGENT_RIPGREP === "off") return null;
  if (rgCache !== undefined) return rgCache;
  rgCache = null;
  const names = process.platform === "win32" ? ["rg.exe", "rg.cmd"] : ["rg"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return (rgCache = candidate); }
      } catch { /* try the next one */ }
    }
  }
  return rgCache;
}

export interface RipgrepRun {
  code: number | null;
  stderr: string;
  /** The caller stopped the run early through `onLine`. */
  stopped: boolean;
}

/**
 * Run ripgrep with an argument array (never a shell), feeding stdout to
 * `onLine` one line at a time. `onLine` returns true to stop early.
 * Rejects when ripgrep cannot start or the signal aborts.
 */
export function runRipgrep(
  rg: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => boolean | void,
  signal?: AbortSignal,
): Promise<RipgrepRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(rg, args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal, windowsHide: true });
    let buffer = "";
    let stderr = "";
    let stopped = false;
    const feed = (line: string): void => {
      if (stopped || line === "") return;
      if (onLine(line)) { stopped = true; child.kill(); }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        feed(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 4000) stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      feed(buffer);
      resolve({ code, stderr, stopped });
    });
  });
}

/** One simple .gitignore line as a matcher: directory names, prefixes and `*` / `?` globs. */
function ignoreMatcher(line: string): ((rel: string, name: string) => boolean) | null {
  let p = line.trim();
  if (!p || p.startsWith("#") || p.startsWith("!")) return null;
  p = p.replace(/\/+$/, "");
  const anchored = p.includes("/");
  p = p.replace(/^\/+/, "");
  if (!p) return null;
  const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*").replace(/\?/g, "[^/]")}$`);
  return anchored ? (rel) => re.test(rel) : (_rel, name) => re.test(name);
}

function readIgnore(root: string): ((rel: string, name: string) => boolean)[] {
  let text: string;
  try { text = fs.readFileSync(path.join(root, ".gitignore"), "utf-8"); } catch { return []; }
  return text.split("\n").map(ignoreMatcher).filter((m): m is NonNullable<typeof m> => m !== null);
}

export interface WalkResult {
  /** Paths relative to the root, with `/` separators. */
  files: string[];
  /** The cap stopped the walk before every file was seen. */
  truncated: boolean;
}

/**
 * Fallback tree walk for when ripgrep is missing. Skips `.git`, node_modules
 * and what the root .gitignore names (simple patterns only); other dotdirs
 * such as `.github` are searched. `accept` filters files before they count
 * against `maxFiles`.
 */
export function walkTree(root: string, maxFiles: number, accept: (rel: string) => boolean = () => true): WalkResult {
  const ignores = readIgnore(root);
  const files: string[] = [];
  let truncated = false;
  const visit = (dir: string, relDir: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (ignores.some((m) => m(rel, entry.name))) continue;
      if (entry.isDirectory()) { visit(path.join(dir, entry.name), rel); continue; }
      if (!accept(rel)) continue;
      if (files.length >= maxFiles) { truncated = true; return; }
      files.push(rel);
    }
  };
  visit(root, "");
  return { files, truncated };
}
