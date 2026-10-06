import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tryFileLock } from "../governance/locks.js";
import { homeDir } from "../home-paths.js";
import { BridgeError } from "./protocol.js";

/** Writing "Allow everywhere" for an OpenCode permission ask: the permission
 * is answered with OpenCode's own `always` reply, which lasts only the running
 * session, so the tool is also added to the user's OpenCode config as an
 * allow rule. The config is read under a lock and rewritten through an atomic
 * rename, so a concurrent OpenCode write is never clobbered and every other
 * key is preserved. */

/** The OpenCode config `phren` edits: ~/.config/opencode/opencode.json. */
export function opencodeConfigPath(env: NodeJS.ProcessEnv = process.env, home = homeDir(env)): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode", "opencode.json");
}

/** A tool name OpenCode's `permission` block keys by. */
export function opencodeToolName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().slice(0, 100);
  return /^[A-Za-z0-9_*-]+$/.test(name) ? name : undefined;
}

async function readConfig(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new BridgeError(409, "Could not read ~/.config/opencode/opencode.json.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new BridgeError(409, "~/.config/opencode/opencode.json is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BridgeError(409, "~/.config/opencode/opencode.json is not a JSON object.");
  return parsed as Record<string, unknown>;
}

/** The config with `permission[tool] = "allow"` added, every other key kept.
 * A granular rule for the tool keeps its patterns: the allow becomes the
 * catch-all `*` (specific rules after it still win, OpenCode's last-match rule). */
export function withAllowedTool(config: Record<string, unknown>, tool: string): Record<string, unknown> {
  const permission = config.permission;
  if (permission === undefined) return { ...config, permission: { [tool]: "allow" } };
  // The whole-block string form ("allow") applies to every tool: keep it as
  // the `*` entry so adding one tool never drops that choice.
  if (typeof permission === "string") return { ...config, permission: { "*": permission, [tool]: "allow" } };
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) {
    throw new BridgeError(409, "The opencode permission block is not a JSON object.");
  }
  const block = { ...(permission as Record<string, unknown>) };
  const existing = block[tool];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    const merged = { "*": "allow", ...(existing as Record<string, unknown>) };
    merged["*"] = "allow";
    block[tool] = merged;
  } else block[tool] = "allow";
  return { ...config, permission: block };
}

/** Add an allow rule for `tool` to the user's OpenCode config, under a lock
 * with an atomic rename. */
export async function allowOpencodeToolEverywhere(tool: unknown, file = opencodeConfigPath()): Promise<string> {
  const name = opencodeToolName(tool);
  if (!name) throw new BridgeError(400, "OpenCode did not name a tool this can allow.");
  const release = tryFileLock(file);
  if (!release) throw new BridgeError(409, "~/.config/opencode/opencode.json is being updated. Try again.");
  try {
    const config = withAllowedTool(await readConfig(file), name);
    const mode = (await lstat(file).catch(() => undefined))?.mode;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: mode === undefined ? 0o600 : mode & 0o777, flag: "wx" });
    try { await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
    return name;
  } finally { release(); }
}
