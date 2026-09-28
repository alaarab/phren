import { lstat, mkdir, readFile, realpath, rmdir, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { claudeConfigDir, codexHome, homeDir } from "../home-paths.js";
import { logger } from "../logger.js";
import { atomic } from "./protocol.js";

/**
 * Marking a folder the Hook chose as trusted, so a Claude or Codex launched
 * there starts without its folder-trust screen. Claude's default on that
 * screen is "No, exit", so a dispatched worker would otherwise sit there
 * until the owner answers it (the brief is never sent; see dispatch.ts).
 *
 * Only callers that picked the folder themselves use this: a dispatched or
 * scheduled project's resolved source folder and a worktree the Hook just
 * created. Never a parent, never a folder the phone typed in. Each harness
 * gets exactly one key for exactly that path:
 *
 * - Claude: `projects[<dir>].hasTrustDialogAccepted = true` in its global
 *   config (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`; a
 *   legacy `<config dir>/.config.json` wins when it exists). Claude checks
 *   that key for the working folder and each parent up to its git root.
 * - Codex: `[projects."<dir>"]` `trust_level = "trusted"` in
 *   `$CODEX_HOME/config.toml`, the table Codex itself writes on "Yes".
 *
 * Both were checked against Claude Code 2.1.280 and codex-cli 0.155.1.
 * `PHREN_PRETRUST=off` turns all of it off.
 */

export type TrustHarness = "claude" | "codex";
export type TrustResult = "trusted" | "already" | "skipped";

export function pretrustEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|0|false|no)$/i.test(env.PHREN_PRETRUST?.trim() ?? "");
}

/** Claude Code's global config file, resolved the way Claude resolves it. */
export async function claudeGlobalConfigFile(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const legacy = path.join(claudeConfigDir(env), ".config.json");
  if (await stat(legacy).then(info => info.isFile(), () => false)) return legacy;
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(configured ? path.resolve(configured) : homeDir(env), ".claude.json");
}

/** Claude takes `<file>.lock` (a proper-lockfile directory) around each config write; so does this. */
const LOCK_WAIT_MS = 3_000, LOCK_STALE_MS = 10_000;

async function withClaudeLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`, deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { await mkdir(lock); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = await stat(lock).catch(() => undefined);
      // A lock nobody refreshed for LOCK_STALE_MS belongs to a process that
      // died holding it; proper-lockfile takes it over the same way.
      if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) { await rmdir(lock).catch(() => undefined); continue; }
      if (Date.now() >= deadline) throw new Error(`${path.basename(lock)} is held by another process`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return await work(); } finally {
    await utimes(lock, new Date(), new Date()).catch(() => undefined);
    await rmdir(lock).catch(() => undefined);
  }
}

/**
 * Sets `projects[dir].hasTrustDialogAccepted` and nothing else. Claude
 * rewrites this file all the time, so the write happens under Claude's own
 * lock, from a fresh read, and is retried when the file changed between the
 * read and the rename. A missing or unparsable file is left alone: that is
 * a Claude that has not finished its own first run, which needs the owner.
 */
export async function ensureClaudeFolderTrusted(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<TrustResult> {
  const configured = await claudeGlobalConfigFile(env);
  // Write through a symlinked config to its target, never over the link.
  const file = await realpath(configured).catch(() => configured);
  // Claude keys projects by forward-slash paths on Windows.
  const key = process.platform === "win32" ? dir.replaceAll("\\", "/") : dir;
  return withClaudeLock(file, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await stat(file).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (!before) return "skipped";
      const text = await readFile(file, "utf8");
      const config: unknown = JSON.parse(text);
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${path.basename(file)} is not a JSON object`);
      const record = config as Record<string, unknown>;
      const projects = record.projects && typeof record.projects === "object" && !Array.isArray(record.projects)
        ? record.projects as Record<string, unknown> : {};
      const current = projects[key];
      const entry = current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : {};
      if (entry.hasTrustDialogAccepted === true) return "already";
      const next = { ...record, projects: { ...projects, [key]: { ...entry, hasTrustDialogAccepted: true } } };
      const now = await stat(file);
      if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) continue;
      await atomic(file, JSON.stringify(next, null, 2), before.mode & 0o777);
      return "trusted";
    }
    throw new Error(`${path.basename(file)} kept changing while it was being updated`);
  });
}

function tomlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The config text with `[projects."<dir>"]` trusted, or undefined when it already is. */
export function codexTrustedText(text: string, dir: string): string | undefined {
  const header = `[projects.${tomlQuote(dir)}]`;
  const trustLine = 'trust_level = "trusted"';
  const at = text.indexOf(header);
  if (at < 0) {
    const separator = text && !text.endsWith("\n") ? "\n\n" : text ? "\n" : "";
    return text + `${separator}${header}\n${trustLine}\n`;
  }
  const bodyStart = at + header.length;
  const rest = text.slice(bodyStart);
  const nextTable = rest.search(/^\s*\[/m);
  const section = nextTable >= 0 ? rest.slice(0, nextTable) : rest;
  if (/^[ \t]*trust_level\s*=\s*"trusted"/m.test(section)) return undefined;
  const existing = /^[ \t]*trust_level\s*=.*$/m.exec(section);
  if (existing) {
    const replaced = section.replace(existing[0], existing[0].match(/^[ \t]*/)![0] + trustLine);
    return text.slice(0, bodyStart) + replaced + rest.slice(section.length);
  }
  const startsWithNewline = section.startsWith("\n") || section.startsWith("\r\n");
  // The table exists without the key: it goes on its own line under the header.
  return text.slice(0, bodyStart) + "\n" + trustLine + (startsWithNewline ? section : "\n" + section) + rest.slice(section.length);
}

/**
 * Adds or flips the one `trust_level` line for `dir` in Codex's
 * `config.toml`, appending the table when it is absent. The rest of the
 * file is kept byte for byte. An unreadable config is left untouched.
 */
export async function ensureCodexDirTrusted(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<TrustResult> {
  const directory = codexHome(env);
  const configured = path.join(directory, "config.toml");
  const file = await realpath(configured).catch(() => configured);
  for (let attempt = 0; attempt < 3; attempt++) {
    let text = "";
    try { text = await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const next = codexTrustedText(text, dir);
    if (next === undefined) return "already";
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(file).catch(() => undefined);
    // Codex may have rewritten the file meanwhile; start over from its text.
    if (await readFile(file, "utf8").catch(() => "") !== text) continue;
    await atomic(file, next, metadata ? metadata.mode & 0o777 : 0o600);
    return "trusted";
  }
  throw new Error("config.toml kept changing while it was being updated");
}

/**
 * Trusts `dir` for `harness` before a launch, when the harness has a trust
 * screen and pre-trust is on. Never throws: a failure is logged and the
 * launch goes on to meet the screen, which dispatch then reports.
 */
export async function pretrustFolder(harness: string, dir: string, why: string, env: NodeJS.ProcessEnv = process.env): Promise<TrustResult> {
  if (harness !== "claude" && harness !== "codex") return "skipped";
  if (!pretrustEnabled(env)) return "skipped";
  if (!path.isAbsolute(dir)) return "skipped";
  const name = harness === "claude" ? "Claude" : "Codex";
  // The same folder by the path the Hook was given and by its real path: the
  // harness keys trust by whichever one its working directory reports.
  const real = await realpath(dir).catch(() => undefined);
  if (!real || !(await stat(real).then(info => info.isDirectory(), () => false))) return "skipped";
  let outcome: TrustResult = "already";
  for (const folder of [...new Set([dir, real])]) {
    try {
      const result = harness === "claude" ? await ensureClaudeFolderTrusted(folder, env) : await ensureCodexDirTrusted(folder, env);
      if (result === "trusted") logger.info("launch", `Marked ${folder} trusted for ${name} (${why}).`);
      else if (result === "skipped") logger.warn("launch", `Did not mark ${folder} trusted for ${name}: its config file does not exist yet.`);
      if (result === "trusted" || (result === "skipped" && outcome === "already")) outcome = result;
    } catch (error) {
      logger.warn("launch", `Could not mark ${folder} trusted for ${name} (${why}): ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      if (outcome === "already") outcome = "skipped";
    }
  }
  return outcome;
}
