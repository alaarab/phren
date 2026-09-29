import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { codexHome } from "../home-paths.js";
import { logger } from "../logger.js";
import { pretrustEnabled } from "./folder-trust.js";
import { atomic, object, objects } from "./protocol.js";

/**
 * Keeping the owner's trust in Phren's own Codex hooks when an install
 * rewrites them.
 *
 * Codex 0.158+ runs a `hooks.json` handler only when `config.toml` holds a
 * matching `trusted_hash` for it, under
 * `[hooks.state."<hooks.json path>:<event_snake>:<group>:<handler>"]`. The
 * hash covers the handler's command, timeout and matcher, so an install that
 * changes Phren's timeout (3 s to 15 s) or moves its group turns a handler the
 * owner trusted into a "modified" one: Codex skips it and every new TUI opens
 * on "Hooks need review".
 *
 * The rule never grants trust the owner did not give. A Phren handler whose
 * key has no matching hash is trusted only when a hash stored for the same
 * event in the same hooks.json is one of:
 *
 * - the same command with a timeout Phren has shipped (3, 10, 15, 60 or none);
 * - a Phren handler for that event in hooks.json as it was before this
 *   install rewrote it (a changed node path, a moved group).
 *
 * A hash cannot come from anything but that event and that command, so a
 * match means the owner trusted Phren's handler there. Other handlers are
 * never touched. `PHREN_PRETRUST=off` turns this off with folder trust.
 */

/** Timeouts Phren's Codex callbacks have carried in any release; undefined is "no timeout key". */
const SHIPPED_TIMEOUTS: (number | undefined)[] = [3, 10, 15, 60, undefined];

const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

/** `SessionStart` to `session_start`, the event name in Codex's trust keys. */
export function codexEventName(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** JSON with every object's keys sorted and no whitespace: serde_json's output for Codex's identity value. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  // JSON.stringify escapes strings as serde_json does: `"`, `\` and control
  // characters only, lowercase \u00xx, non-ASCII left as UTF-8.
  return JSON.stringify(value);
}

/**
 * Codex's `hook_hash` for one handler in one group (codex-rs hooks
 * discovery + config fingerprint): sha256 of the canonical JSON of
 * `{ event_name, matcher?, hooks: [handler] }`, where the handler always
 * carries `timeout` (default 600, at least 1) and `async` (default false).
 */
export function codexHookHash(event: string, group: Record<string, unknown>, handler: Record<string, unknown>): string {
  const name = codexEventName(event);
  const shortLived = name === "session_end" || name === "interrupt";
  const given = typeof handler.timeout === "number" ? handler.timeout : undefined;
  const timeout = shortLived ? Math.min(3, Math.max(1, given ?? 1)) : Math.max(1, given ?? 600);
  const hook: Record<string, unknown> = { type: handler.type ?? "command", command: handler.command, timeout, async: handler.async ?? false };
  for (const key of ["statusMessage", "commandWindows", "additionalContextLimit"]) {
    if (handler[key] !== undefined && handler[key] !== null) hook[key] = handler[key];
  }
  const identity: Record<string, unknown> = { event_name: name, hooks: [hook] };
  if (typeof group.matcher === "string") identity.matcher = group.matcher;
  return `sha256:${createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex")}`;
}

interface OwnHandler { event: string; group: Record<string, unknown>; handler: Record<string, unknown>; groupIndex: number; handlerIndex: number }

/** Phren's own handlers in a Codex hooks.json text; none when it does not parse. */
function ownHandlers(text: string | undefined, program: string): OwnHandler[] {
  if (text === undefined) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const suffix = ` ${quote(program)} hook codex`;
  const found: OwnHandler[] = [];
  for (const [event, groups] of Object.entries(object(object(parsed).hooks))) {
    objects(groups).forEach((group, groupIndex) => objects(group.hooks).forEach((handler, handlerIndex) => {
      if (typeof handler.command === "string" && handler.command.endsWith(suffix)) found.push({ event, group, handler, groupIndex, handlerIndex });
    }));
  }
  return found;
}

const TABLE = /^[ \t]*\[[ \t]*hooks[ \t]*\.[ \t]*state[ \t]*\.[ \t]*("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')[ \t]*\][ \t]*(?:#.*)?$/;
const HASH_LINE = /^[ \t]*trusted_hash[ \t]*=[ \t]*"([^"\r\n]*)"/;

interface StateTable { key: string; header: number; end: number; hash?: string; hashLine?: number }

/** The `[hooks.state."<key>"]` tables of a config.toml, by line. */
function stateTables(lines: string[]): StateTable[] {
  const tables: StateTable[] = [];
  let current: StateTable | undefined;
  lines.forEach((line, index) => {
    if (/^[ \t]*\[/.test(line)) {
      if (current) current.end = index;
      current = undefined;
      const match = TABLE.exec(line);
      if (!match) return;
      let key: string;
      try { key = match[1].startsWith("'") ? match[1].slice(1, -1) : JSON.parse(match[1]) as string; } catch { return; }
      current = { key, header: index, end: lines.length };
      tables.push(current);
      return;
    }
    const hash = current && current.hash === undefined ? HASH_LINE.exec(line) : null;
    if (current && hash) { current.hash = hash[1]; current.hashLine = index; }
  });
  return tables;
}

function tomlKey(value: string): string {
  return `"${value.replace(/[\\"\u0000-\u001f\u007f]/g, c => c === "\\" ? "\\\\" : c === "\"" ? "\\\"" : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

/**
 * The config text with trust carried forward to Phren's handlers in
 * `hooks` (the hooks.json text as it is now), or undefined when nothing
 * changes. `before` is hooks.json as it stood before this install rewrote
 * it, when there was a rewrite. `hooksPaths` are the names Codex may key
 * this hooks.json by; the first is used for a new key.
 */
export function codexHookTrustText(config: string, hooks: string, program: string, hooksPaths: string[], before?: string): { text: string; carried: string[] } | undefined {
  const own = ownHandlers(hooks, program);
  if (!own.length) return undefined;
  const newline = config.includes("\r\n") ? "\r\n" : "\n";
  const lines = config.split(/\r?\n/);
  const tables = stateTables(lines);
  const split = (key: string) => {
    const match = /^(.*):([a-z_]+):(\d+):(\d+)$/.exec(key);
    return match && hooksPaths.includes(match[1]) ? { file: match[1], event: match[2] } : undefined;
  };
  const stored = tables.flatMap(table => { const parts = split(table.key); return parts && table.hash ? [{ ...parts, hash: table.hash }] : []; });
  if (!stored.length) return undefined;
  const keyPath = stored[0].file;
  const previous = ownHandlers(before, program);
  const edits = new Map<number, string>(), appended: string[] = [], carried: string[] = [];
  for (const entry of own) {
    const name = codexEventName(entry.event);
    const key = `${keyPath}:${name}:${entry.groupIndex}:${entry.handlerIndex}`;
    const want = codexHookHash(entry.event, entry.group, entry.handler);
    const table = tables.find(t => t.key === key);
    if (table?.hash === want) continue;
    const accepted = new Set([
      ...SHIPPED_TIMEOUTS.map(timeout => codexHookHash(entry.event, entry.group, { ...entry.handler, timeout })),
      ...previous.filter(p => p.event === entry.event).map(p => codexHookHash(p.event, p.group, p.handler)),
    ]);
    if (!stored.some(s => s.event === name && accepted.has(s.hash))) continue;
    const line = `trusted_hash = "${want}"`;
    if (table?.hashLine !== undefined) edits.set(table.hashLine, lines[table.hashLine].replace(/"[^"]*"/, `"${want}"`));
    else if (table) edits.set(table.header, `${lines[table.header]}${newline}${line}`);
    else appended.push(`[hooks.state.${tomlKey(key)}]${newline}${line}${newline}`);
    carried.push(key);
  }
  if (!carried.length) return undefined;
  const next = lines.map((line, index) => edits.get(index) ?? line);
  if (appended.length) {
    // New tables go right after the last hooks.state table, next to their siblings.
    const last = tables[tables.length - 1];
    const insertAt = last.end;
    const block = appended.join(newline);
    if (insertAt < next.length) next.splice(insertAt, 0, ...block.split(newline).slice(0, -1), "");
    else {
      const text = next.join(newline);
      const separator = text.endsWith(newline + newline) || text === "" ? "" : text.endsWith(newline) ? newline : newline + newline;
      return { text: text + separator + block, carried };
    }
  }
  return { text: next.join(newline), carried };
}

/**
 * Carries the owner's Codex trust forward to Phren's handlers in
 * `$CODEX_HOME/hooks.json`. Runs after every install, update, rollback and
 * module reconcile, whether or not hooks.json changed, so a computer an
 * earlier install left untrusted is repaired too. Never throws.
 */
export async function carryCodexHookTrust(program: string, before?: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (!pretrustEnabled(env)) return [];
  try {
    const directory = codexHome(env);
    const hooksFile = path.join(directory, "hooks.json");
    const hooks = await readFile(hooksFile, "utf8").catch(() => undefined);
    if (hooks === undefined) return [];
    const hooksPaths = [...new Set([hooksFile, await realpath(hooksFile).catch(() => hooksFile)])];
    const configured = path.join(directory, "config.toml");
    const file = await realpath(configured).catch(() => configured);
    for (let attempt = 0; attempt < 3; attempt++) {
      const text = await readFile(file, "utf8").catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      // No config means the owner never trusted anything.
      if (text === undefined) return [];
      const result = codexHookTrustText(text, hooks, program, hooksPaths, before);
      if (!result) return [];
      const metadata = await lstat(file);
      // Codex may have rewritten the file meanwhile; start over from its text.
      if (await readFile(file, "utf8").catch(() => "") !== text) continue;
      await atomic(file, result.text, metadata.mode & 0o777);
      logger.info("install", `Kept Codex trust for Phren's rewritten hooks: ${result.carried.join(", ")}.`);
      return result.carried;
    }
    throw new Error("config.toml kept changing while it was being updated");
  } catch (error) {
    logger.warn("install", `Could not carry Codex hook trust forward: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return [];
  }
}
