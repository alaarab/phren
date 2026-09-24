import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CLAUDE_MENU, claudeName, ModelCatalog, readClaudeModels, readOpenCodeModels } from "./models.js";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

/** The `case "..."` block of a Swift switch, from its first `from` to `to`. */
function swiftSection(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect(start, `missing ${from}`).toBeGreaterThan(-1);
  const end = text.indexOf(to, start + from.length);
  return text.slice(start, end < 0 ? text.length : end);
}

/** `[argument, name]` rows written as `AgentModelChoice(name:..., argument:...)`. */
function swiftRows(section: string): [string, string][] {
  return [...section.matchAll(/name: "([^"]+)", argument: "([^"]+)"/g)].map(match => [match[2], match[1]]);
}

/** The arguments a Swift section marks `isDefault: true`, in list order. */
function swiftDefaults(section: string): string[] {
  return [...section.matchAll(/argument: "([^"]+)"[^\n]*isDefault: true/g)].map(match => match[1]);
}

describe("model catalogue", () => {
  it("kills a stuck Claude version probe instead of leaving it running after timeout", async () => {
    const config = await mkdtemp(path.join(tmpdir(), "phren-claude-timeout-"));
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      kill: vi.fn((signal: string) => {
        if (signal === "SIGKILL") child.emit("exit", null, signal);
        return true;
      }),
    });
    vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>);
    vi.useFakeTimers();
    try {
      const result = readClaudeModels(config);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toEqual(CLAUDE_MENU);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers(); child.stdout.destroy();
      await rm(config, { recursive: true, force: true });
    }
  });

  it("keeps claudeName in step with the menu it titles", () => {
    // claudeName reads menu-shaped ids for bridge step labels; every menu
    // row must spell its own display name.
    expect(CLAUDE_MENU.map(model => model.name)).toEqual(CLAUDE_MENU.map(model => claudeName(model.id)));
    expect(claudeName("sonnet")).toBe("Sonnet");
  });

  it("falls back to the built-in menu when Claude Code has no catalogue on this computer", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "phren-claude-"));
    const models = await readClaudeModels(empty, null);
    expect(models.map(model => [model.id, model.name])).toEqual(CLAUDE_MENU.map(model => [model.id, model.name]));
    expect(models.filter(model => model.isDefault).map(model => model.id)).toEqual(["claude-fable-5-1"]);
    // The table is a fresh copy each call, so a caller cannot corrupt it.
    models[0].name = "Changed";
    expect((await readClaudeModels(empty, null))[0].name).toBe("Fable 5.1");
  });

  it("reads Claude Code's own cached catalogue: its order, its default, a 1M row for the default, and nothing the client is too old for", async () => {
    const config = await mkdtemp(path.join(tmpdir(), "phren-claude-"));
    await mkdir(path.join(config, "cache/model-catalog"), { recursive: true });
    const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, section: "main", ...extra });
    await writeFile(path.join(config, "cache/model-catalog/account-abc-cc.json"), JSON.stringify({ version: 2, catalog: {
      surface: "cc",
      config: { id: "cc", models: [
        row("claude-opus-5-5", "Opus 5.5", { description: "For complex tasks", min_claude_code_version: "2.1.280",
          thinking: { type: "effort", effort_options: [{ id: "low" }, { id: "medium", badge: { message: "Default" } }, { id: "high" }, { id: "xhigh" }, { id: "max" }] } }),
        row("claude-sonnet-5", "Sonnet 5", { description: "Most efficient for everyday tasks" }),
        row("claude-future-9", "Future 9", { min_claude_code_version: "9.0.0" }),
        row("claude-opus-4-8", "Opus 4.8", { section: "overflow" }),
      ] },
      state: { id: "cc", model: "claude-opus-5-5" },
    } }));
    expect((await readClaudeModels(config, "2.1.280")).map(model => [model.id, model.name, !!model.isDefault])).toEqual([
      ["claude-opus-5-5", "Opus 5.5", true],
      ["claude-sonnet-5", "Sonnet 5", false],
      ["claude-opus-5-5[1m]", "Opus 5.5 (1M context)", false],
      ["claude-opus-4-8", "Opus 4.8", false],
    ]);
    // Each model carries the effort levels `--effort` takes for it, the 1M row too.
    const models = await readClaudeModels(config, "2.1.280");
    expect(models[0]).toMatchObject({ supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" });
    expect(models[2].supportedReasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models[1].supportedReasoningEfforts).toBeUndefined();
    // A client older than a row's minimum does not see that row.
    expect((await readClaudeModels(config, "2.1.279")).map(model => model.id)).not.toContain("claude-opus-5-5");
  });

  it("keeps the phone's built-in fallbacks and the chat fixture in step with the menu", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
    const [phone, fixture] = await Promise.all([
      readFile(path.join(root, "apps/ios/PhrenKit/Sources/PhrenKit/Sessions/AgentModelChoice.swift"), "utf8"),
      readFile(path.join(root, "apps/ios/Phren/Features/Agents/AgentChatFixture.swift"), "utf8"),
    ]);
    const menu = CLAUDE_MENU.map(model => [model.id, model.name] as [string, string]);
    const phoneClaude = swiftSection(phone, 'case "claude":', 'case "codex":');
    expect(fixture).toContain("AgentModelChoice.choices(source: source)");
    const phoneCodex = swiftSection(phone, 'case "codex":', "default:");

    expect(swiftRows(phoneClaude)).toEqual(menu);
    expect([...phoneClaude.matchAll(/description: "([^"]+)"/g)].map(match => match[1])).toEqual(CLAUDE_MENU.map(model => model.description));

    expect(swiftDefaults(phoneClaude)).toEqual(["claude-fable-5-1"]);

    // The Codex built-in mirrors the fixture's app-server shape the same way.
    expect(swiftRows(phoneCodex).map(([id]) => id)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"]);
    expect(swiftDefaults(phoneCodex)).toEqual(["gpt-6-astra"]);

  });

  it("caches per source and never lists a provider it does not know", async () => {
    let calls = 0;
    const catalog = new ModelCatalog(async () => { calls++; return [{ id: "gpt-x", name: "X" }]; }, async () => []);
    expect(await catalog.list("codex")).toEqual([{ id: "gpt-x", name: "X" }]);
    expect(await catalog.list("codex")).toEqual([{ id: "gpt-x", name: "X" }]);
    expect(calls).toBe(1);
    expect(await catalog.list("copilot")).toEqual([]);
  });

  it("lists OpenCode's models with the Go plan first and the configured one marked", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "phren-opencode-"));
    const bin = path.join(dir, "opencode");
    await writeFile(bin, "#!/bin/sh\nprintf 'opencode/big-pickle\\nopenrouter/deepseek/deepseek-v4.1-flash\\nopencode-go/kimi-k3\\nopencode/mimo-v2.5-free\\nnot a model line\\n'\n", { mode: 0o755 });
    await writeFile(path.join(dir, "opencode.json"), JSON.stringify({ model: "openrouter/deepseek/deepseek-v4.1-flash" }));
    const models = await readOpenCodeModels(bin, dir);
    expect(models.map(model => model.id)).toEqual(["opencode-go/kimi-k3", "opencode/big-pickle", "opencode/mimo-v2.5-free", "openrouter/deepseek/deepseek-v4.1-flash"]);
    expect(models[0]).toMatchObject({ name: "kimi-k3", description: "OpenCode Go plan." });
    expect(models[2].description).toBe("OpenCode Zen, free.");
    expect(models[3]).toMatchObject({ isDefault: true, description: "Through openrouter." });
    await rm(dir, { recursive: true, force: true });
  });
});
