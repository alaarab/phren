import { spawn } from "node:child_process";
import { readdir, readFile, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { object, objects, type Json } from "./protocol.js";

/** One entry of a `/model` menu as the phone draws it. */
export interface AgentModel { id: string; name: string; description?: string; isDefault?: boolean; isCurrent?: boolean }

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

function codexModels(result: Json): AgentModel[] {
  return objects(result.data).filter(entry => entry.hidden !== true && typeof entry.id === "string" && entry.id).slice(0, 32).map(entry => ({
    id: String(entry.id).slice(0, 100),
    name: String(entry.displayName || entry.id).slice(0, 100),
    ...(typeof entry.description === "string" && entry.description ? { description: entry.description.slice(0, 300) } : {}),
    ...(entry.isDefault === true ? { isDefault: true } : {}),
  }));
}

/** Claude Code publishes no catalogue. Its `/model` takes an alias for the
 * latest of each family or a full id; the ids this computer has actually
 * run, read from the first rows of its recent transcripts, fill the rest. */
export async function readClaudeModels(now = Date.now()): Promise<AgentModel[]> {
  const root = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  const aliases: AgentModel[] = [
    { id: "fable", name: "Fable", description: "The latest Fable model." },
    { id: "opus", name: "Opus", description: "The latest Opus model." },
    { id: "sonnet", name: "Sonnet", description: "The latest Sonnet model." },
    { id: "haiku", name: "Haiku", description: "The latest Haiku model." },
  ];
  const seen = new Map<string, number>();
  try {
    const projects = path.join(root, "projects");
    const files: { file: string; mtimeMs: number }[] = [];
    for (const dir of await readdir(projects, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const folder = path.join(projects, dir.name);
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const info = await stat(path.join(folder, entry.name)).catch(() => undefined);
        if (info && now - info.mtimeMs < 30 * 86_400_000) files.push({ file: path.join(folder, entry.name), mtimeMs: info.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { file } of files.slice(0, 40)) {
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.alloc(262_144);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        for (const match of buffer.toString("utf8", 0, bytesRead).matchAll(/"model":"(claude-[a-z0-9.-]{1,60})"/g)) {
          seen.set(match[1], (seen.get(match[1]) ?? 0) + 1);
        }
      } finally { await handle.close(); }
    }
  } catch { /* No transcripts is not an error; the aliases still stand. */ }
  let configured: string | undefined;
  try {
    const settings = object(JSON.parse(await readFile(path.join(root, "settings.json"), "utf8")));
    if (typeof settings.model === "string" && settings.model) configured = settings.model.slice(0, 100);
  } catch { /* The default model is fine to leave unnamed. */ }
  const ids = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id);
  const full: AgentModel[] = ids.map(id => ({ id, name: claudeName(id), description: "Run on this computer recently." }));
  const models = [...aliases, ...full];
  if (configured && !models.some(model => model.id === configured)) models.push({ id: configured, name: claudeName(configured), description: "Set in Claude Code's settings." });
  return models.map(model => model.id === configured ? { ...model, isDefault: true } : model);
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
  constructor(private readonly codex = () => readCodexModels(), private readonly claude = () => readClaudeModels()) {}
  list(source: string): Promise<AgentModel[]> {
    const cached = this.cache.get(source);
    if (cached && Date.now() - cached.at < 600_000) return cached.value;
    const value = (source === "codex" ? this.codex() : source === "claude" ? this.claude() : Promise.resolve([])).catch(() => [] as AgentModel[]);
    this.cache.set(source, { at: Date.now(), value });
    return value;
  }
}
