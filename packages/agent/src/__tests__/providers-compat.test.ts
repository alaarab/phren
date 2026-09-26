import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEEPSEEK_BASE_URL, resolveProvider } from "../providers/resolve.js";
import type { OpenAiProvider } from "../providers/openrouter.js";
import { findEventLogById, listEventLogs, fileSink } from "../session/persist.js";
import { SessionLog } from "../session/log.js";
import { buildProjectInstructions } from "../memory/context.js";

const ENV_KEYS = [
  "HOME", "USERPROFILE", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY",
  "PHREN_AGENT_PROVIDER", "PHREN_AGENT_BASE_URL", "PHREN_AGENT_API_KEY", "PHREN_AGENT_REPLAY", "PHREN_OLLAMA_URL",
];

describe("DeepSeek and OpenAI-compatible providers", () => {
  const saved: Record<string, string | undefined> = {};
  let home: string;

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    home = fs.mkdtempSync(path.join(os.tmpdir(), "compat-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    for (const k of ENV_KEYS.slice(2)) delete process.env[k];
    process.env.PHREN_OLLAMA_URL = "off";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("--provider deepseek uses api.deepseek.com with DEEPSEEK_API_KEY and the catalog default", () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds";
    const p = resolveProvider("deepseek") as OpenAiProvider;
    expect(p.name).toBe("deepseek");
    expect(p.model).toBe("deepseek-flash");
    expect(p.contextWindow).toBe(1_000_000);
    expect((p as unknown as { baseUrl: string }).baseUrl).toBe(DEEPSEEK_BASE_URL);
  });

  it("auto-detects DeepSeek from DEEPSEEK_API_KEY alone", () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds";
    expect(resolveProvider().name).toBe("deepseek");
  });

  it("deepseek without a key explains what to set", () => {
    expect(() => resolveProvider("deepseek")).toThrow(/DEEPSEEK_API_KEY/);
  });

  it("openai-compat needs an endpoint and a model", () => {
    expect(() => resolveProvider("openai-compat", "m")).toThrow(/--base-url/);
    expect(() => resolveProvider("openai-compat", undefined, undefined, undefined, { baseUrl: "https://x.test/v1" })).toThrow(/--model/);
  });

  it("openai-compat sends to the given endpoint with PHREN_AGENT_API_KEY", async () => {
    process.env.PHREN_AGENT_API_KEY = "sk-compat";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const p = resolveProvider("openai-compat", "glm-5", undefined, undefined, { baseUrl: "https://opencode.test/zen/v1/" });
    expect(p.name).toBe("openai-compat");
    const res = await p.chat("sys", [{ role: "user", content: "x" }], []);
    expect(res.content[0]).toMatchObject({ type: "text", text: "hi" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://opencode.test/zen/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-compat");
    expect(JSON.parse(String(init.body)).model).toBe("glm-5");
  });

  it("PHREN_AGENT_BASE_URL works in place of --base-url (model switches and children use it)", () => {
    process.env.PHREN_AGENT_BASE_URL = "http://127.0.0.1:8000/v1";
    expect(resolveProvider("openai-compat", "local-model").name).toBe("openai-compat");
  });

  it("errors name the endpoint, not OpenAI", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));
    await expect(resolveProvider("deepseek").chat("s", [{ role: "user", content: "x" }], [])).rejects.toThrow(/^deepseek API error 401/);
  });

  it("an unknown provider name is an error, not a silent fallback", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(() => resolveProvider("deepsek")).toThrow(/Unknown provider "deepsek"/);
  });

  it("OpenRouter DeepSeek ids match the live catalog", () => {
    process.env.OPENROUTER_API_KEY = "sk-or";
    for (const id of ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v3.2"]) {
      const p = resolveProvider("openrouter", id);
      expect(p.contextWindow, id).toBeGreaterThan(100_000);
    }
  });
});

describe("Codex default model", () => {
  let codexHome: string;
  beforeEach(() => { codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-")); });
  afterEach(() => fs.rmSync(codexHome, { recursive: true, force: true }));

  it("follows the Codex CLI's configured model, ignoring table keys", async () => {
    const { codexConfiguredModel } = await import("../providers/codex-auth.js");
    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n[profiles.x]\nmodel = "other"\n');
    expect(codexConfiguredModel(codexHome)).toBe("gpt-6-astra");
  });

  it("falls back to the first cached model, then to nothing", async () => {
    const { codexConfiguredModel } = await import("../providers/codex-auth.js");
    expect(codexConfiguredModel(codexHome)).toBeUndefined();
    fs.writeFileSync(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-5.6-terra" }] }));
    expect(codexConfiguredModel(codexHome)).toBe("gpt-5.6-terra");
  });
});

describe("session listing and resume by id", () => {
  let store: string;
  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-store-"));
  });
  afterEach(() => fs.rmSync(store, { recursive: true, force: true }));

  function writeSession(id: string, prompt: string, project = "proj") {
    const log = new SessionLog({ sessionId: id, project, cwd: "/w", createdAt: new Date().toISOString() }, fileSink(store, id));
    log.append("user/message", { message: { role: "user", content: prompt }, source: "user", turn: 0 });
    log.append("assistant/message", { message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, stop_reason: "end_turn", turn: 0 });
  }

  it("lists sessions newest first with their first prompt", () => {
    writeSession("aaaa1111", "fix the login bug");
    writeSession("bbbb2222", "add a --json flag", "other");
    const all = listEventLogs(store);
    expect(all.map((s) => s.sessionId).sort()).toEqual(["aaaa1111", "bbbb2222"]);
    expect(all.find((s) => s.sessionId === "aaaa1111")).toMatchObject({ title: "fix the login bug", messages: 2, project: "proj" });
    expect(listEventLogs(store, { project: "other" }).map((s) => s.sessionId)).toEqual(["bbbb2222"]);
  });

  it("finds a session by unique id prefix and rejects ambiguous or unknown ones", () => {
    writeSession("abc-1", "one");
    writeSession("abc-2", "two");
    expect(findEventLogById(store, "abc-1")).toMatch(/session-abc-1\.events\.jsonl$/);
    expect(() => findEventLogById(store, "abc")).toThrow(/matches 2 sessions/);
    expect(() => findEventLogById(store, "zzz")).toThrow(/no session matches/);
  });
});

describe("project instructions without a phren store", () => {
  const cwd = process.cwd();
  let dir: string;
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads AGENTS.md from the working directory, well past the old 4,000-char cap", () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "instr-")));
    fs.writeFileSync(path.join(dir, "AGENTS.md"), `# Rules\n${"use pnpm. ".repeat(900)}\nFINAL-RULE`);
    process.chdir(dir);
    const section = buildProjectInstructions();
    expect(section).toContain("## Project instructions");
    expect(section).toContain("FINAL-RULE");
  });
});
