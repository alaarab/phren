import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { object, objects, type Json } from "./protocol.js";

/** One entry of a `/model` menu as the phone draws it. */
export interface AgentModel {
  id: string; name: string; description?: string; isDefault?: boolean; isCurrent?: boolean;
  defaultReasoningEffort?: string; supportedReasoningEfforts?: string[];
}

/** Only initialize and list. Never a thread, a prompt, or a login. */
export function readCodexModels(executable = "codex"): Promise<AgentModel[]> {
  return new Promise(resolve => {
    const child = spawn(executable, ["app-server"], { cwd: homedir(), stdio: ["pipe", "pipe", "ignore"] });
    let pending = "", bytes = 0, initialized = false, done = false;
    const finish = (result: AgentModel[] = []) => {
      if (done) return; done = true;
      clearTimeout(timer); child.stdin.destroy(); child.stdout.destroy();
      child.kill("SIGTERM");
      const kill = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000);
      kill.unref(); child.once("exit", () => clearTimeout(kill));
      resolve(result);
    };
    const timer = setTimeout(() => finish(), 12_000);
    const send = (value: Json) => { if (!done) child.stdin.write(JSON.stringify(value) + "\n"); };
    child.on("error", () => finish()); child.on("exit", () => finish()); child.stdin.on("error", () => finish());
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1_048_576) { finish(); return; }
      pending += chunk;
      let newline: number;
      while (!done && (newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const response = object(JSON.parse(line));
          if (response.id === 0 && !initialized) {
            if (response.error || !response.result) { finish(); return; }
            initialized = true;
            send({ method: "initialized", params: {} });
            send({ id: 1, method: "model/list", params: {} });
          } else if (response.id === 1 && initialized) {
            finish(response.error ? [] : codexModels(object(response.result)));
          } else if (response.method && response.id !== undefined) {
            send({ id: response.id, error: { code: -32601, message: "Unsupported request" } });
          }
        } catch { finish(); }
      }
    });
    send({ id: 0, method: "initialize", params: { clientInfo: { name: "phren_models", title: "Phren Models", version: "1" } } });
  });
}

export function codexModels(result: Json): AgentModel[] {
  return objects(result.data).filter(entry => entry.hidden !== true && typeof entry.id === "string" && entry.id).slice(0, 32).map(entry => ({
    id: String(entry.id).slice(0, 100),
    name: String(entry.displayName || entry.id).slice(0, 100),
    ...(typeof entry.description === "string" && entry.description ? { description: entry.description.slice(0, 300) } : {}),
    ...(entry.isDefault === true ? { isDefault: true } : {}),
    ...(typeof entry.defaultReasoningEffort === "string" ? { defaultReasoningEffort: entry.defaultReasoningEffort } : {}),
    supportedReasoningEfforts: objects(entry.supportedReasoningEfforts).flatMap(value =>
      typeof value.reasoningEffort === "string" ? [value.reasoningEffort] : []),
  }));
}

/** The menu used only when Claude Code's own catalogue cannot be read (it has
 * never run on this computer, or the cache is unreadable). Normally the phone
 * shows the live catalogue below, so a new model appears without anyone
 * editing this table. Exported so a parity test can hold the phone's built-in
 * offline fallback and the chat fixture to it. */
export const CLAUDE_MENU: readonly AgentModel[] = [
  { id: "claude-fable-5-1", name: "Fable 5.1", description: "Most intelligent.", isDefault: true },
  { id: "claude-opus-5", name: "Opus 5", description: "Most capable for long work." },
  { id: "claude-sonnet-5", name: "Sonnet 5", description: "Fast and capable." },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", description: "Fastest and lightest." },
  { id: "claude-fable-5-1[1m]", name: "Fable 5.1 (1M context)", description: "Fable 5.1 with a 1M context window." },
];

/** Claude Code fetches its `/model` catalogue from Anthropic and caches it as
 * `<config>/cache/model-catalog/<account>-...-cc.json`, refreshing it itself:
 * `catalog.config.models` is the menu in the terminal's order (`section`
 * "main" first, older models under "overflow"), each row gated by
 * `min_claude_code_version`, and `catalog.state.model` is the selected
 * default. Reading that file keeps the phone's picker identical to the
 * terminal's with nothing to maintain here. */
export async function readClaudeCatalog(configDir = claudeConfigDir(), installed?: string): Promise<AgentModel[]> {
  const directory = path.join(configDir, "cache", "model-catalog");
  let newest: { file: string; at: number } | undefined;
  try {
    for (const name of await readdir(directory)) {
      if (!name.endsWith("-cc.json")) continue;
      const file = path.join(directory, name), at = (await stat(file)).mtimeMs;
      if (!newest || at > newest.at) newest = { file, at };
    }
  } catch { return []; }
  if (!newest) return [];
  let parsed: Json;
  try { parsed = JSON.parse(await readFile(newest.file, "utf8")) as Json; } catch { return []; }
  const catalog = object(object(parsed).catalog);
  const selected = typeof object(catalog.state).model === "string" ? String(object(catalog.state).model) : undefined;
  const rows = objects(object(catalog.config).models).filter(row => typeof row.id === "string" && /^[a-z0-9.[\]-]{1,100}$/i.test(row.id));
  const usable = rows.filter(row => !installed || typeof row.min_claude_code_version !== "string" || !olderVersion(installed, row.min_claude_code_version));
  const ordered = [...usable.filter(row => row.section !== "overflow"), ...usable.filter(row => row.section === "overflow")];
  const models: AgentModel[] = ordered.map(row => ({
    id: String(row.id),
    name: typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 100) : claudeName(String(row.id)),
    ...(typeof row.description === "string" && row.description.trim() ? { description: row.description.trim().slice(0, 300) } : {}),
    ...(String(row.id) === selected ? { isDefault: true } : {}),
  }));
  // The terminal offers the selected model with a 1M context window as its
  // own row; the catalogue does not list that variant, so add it after the
  // main section the way the menu draws it.
  const chosen = models.find(model => model.isDefault);
  if (chosen && !models.some(model => model.id === `${chosen.id}[1m]`)) {
    const main = models.filter(model => ordered.find(row => row.id === model.id)?.section !== "overflow").length;
    models.splice(main, 0, { id: `${chosen.id}[1m]`, name: `${chosen.name} (1M context)`, description: `${chosen.name} with a 1M context window.` });
  }
  return models;
}

function claudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(homedir(), ".claude");
}

/** "2.1.279" is older than "2.1.280"; anything unparseable is not. */
function olderVersion(installed: string, required: string): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim())?.slice(1).map(Number);
  const have = parse(installed), need = parse(required);
  if (!have || !need) return false;
  for (let index = 0; index < 3; index++) if (have[index] !== need[index]) return have[index] < need[index];
  return false;
}

/** The installed client's version, so a model it cannot run is not offered. */
function claudeVersion(executable = "claude"): Promise<string | undefined> {
  return new Promise(resolve => {
    const child = spawn(executable, ["--version"], { cwd: homedir(), stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(undefined); }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (out.length < 4_096) out += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve(undefined); });
    child.on("exit", () => { clearTimeout(timer); resolve(/\d+\.\d+\.\d+/.exec(out)?.[0]); });
  });
}

/** The live catalogue when Claude Code has one cached on this computer,
 * otherwise the offline fallback, copied per call so a caller cannot mutate it. */
export async function readClaudeModels(configDir?: string, installed?: string | null): Promise<AgentModel[]> {
  const version = installed === null ? undefined : installed ?? await claudeVersion();
  const live = await readClaudeCatalog(configDir, version).catch(() => [] as AgentModel[]);
  return live.length ? live : CLAUDE_MENU.map(model => ({ ...model }));
}

/** `opencode models` prints one `provider/model` id per line. The Go plan's
 * models sit under `opencode-go/`, Zen's under `opencode/`, and everything
 * else under the gateway it came from; the configured default is marked. */
export async function readOpenCodeModels(executable = "opencode", configDir = path.join(homedir(), ".config/opencode")): Promise<AgentModel[]> {
  const listed = await new Promise<string>(resolve => {
    const child = spawn(executable, ["models"], { cwd: homedir(), stdio: ["ignore", "pipe", "ignore"] });
    let out = "", done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(out); } };
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(); }, 12_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (out.length < 262_144) out += chunk; });
    child.on("error", finish); child.on("exit", finish);
  });
  const ids = [...new Set(listed.split(/\r?\n/).map(line => line.trim()).filter(line => /^[a-z0-9~.-]+\/[^\s]+$/i.test(line)))].slice(0, 400);
  if (!ids.length) return [];
  let configured: string | undefined;
  for (const file of ["opencode.json", "opencode.jsonc"]) {
    try {
      const text = await readFile(path.join(configDir, file), "utf8");
      const model = /"model"\s*:\s*"([^"]+)"/.exec(text)?.[1];
      if (model) { configured = model.slice(0, 200); break; }
    } catch { /* No config means no default to mark. */ }
  }
  const rank = (id: string) => id.startsWith("opencode-go/") ? 0 : id.startsWith("opencode/") ? 1 : 2;
  return ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map(id => {
    const provider = id.slice(0, id.indexOf("/")), name = id.slice(id.indexOf("/") + 1);
    const description = provider === "opencode-go" ? "OpenCode Go plan." : provider === "opencode" ? (name.endsWith("-free") ? "OpenCode Zen, free." : "OpenCode Zen, per token.") : `Through ${provider}.`;
    return { id, name, description, ...(id === configured ? { isDefault: true } : {}) };
  });
}

/** "claude-fable-5-1" reads as "Fable 5.1"; a date suffix is dropped. */
export function claudeName(id: string): string {
  const parts = id.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/\[1m\]$/, "").split("-");
  const family = parts.shift() ?? id;
  const version = parts.filter(part => /^\d+$/.test(part)).join(".");
  const name = family.charAt(0).toUpperCase() + family.slice(1) + (version ? ` ${version}` : "");
  return id.endsWith("[1m]") ? `${name} (1M context)` : name;
}

/** Catalogues change rarely and app-server takes seconds to start. */
export class ModelCatalog {
  private cache = new Map<string, { at: number; value: Promise<AgentModel[]> }>();
  constructor(private readonly codex = () => readCodexModels(), private readonly claude = () => readClaudeModels(),
              private readonly opencode = () => readOpenCodeModels()) {}
  list(source: string): Promise<AgentModel[]> {
    const cached = this.cache.get(source);
    if (cached && Date.now() - cached.at < 600_000) return cached.value;
    const value = (source === "codex" ? this.codex() : source === "claude" ? this.claude() : source === "opencode" ? this.opencode() : Promise.resolve([])).catch(() => [] as AgentModel[]);
    this.cache.set(source, { at: Date.now(), value });
    return value;
  }
}
