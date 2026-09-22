import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLAUDE_MENU, claudeName, ModelCatalog, readClaudeModels, readOpenCodeModels } from "./models.js";

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
  it("keeps claudeName in step with the menu it titles", () => {
    // claudeName reads menu-shaped ids for bridge step labels; every menu
    // row must spell its own display name.
    expect(CLAUDE_MENU.map(model => model.name)).toEqual(CLAUDE_MENU.map(model => claudeName(model.id)));
    expect(claudeName("sonnet")).toBe("Sonnet");
  });

  it("lists Claude's menu exactly the way Claude Code shows it, the default first", async () => {
    const models = await readClaudeModels();
    expect(models.map(model => [model.id, model.name])).toEqual(CLAUDE_MENU.map(model => [model.id, model.name]));
    expect(models.map(model => [model.id, model.name])).toEqual([
      ["claude-fable-5-1", "Fable 5.1"],
      ["claude-opus-5", "Opus 5"],
      ["claude-sonnet-5", "Sonnet 5"],
      ["claude-haiku-4-5-20251001", "Haiku 4.5"],
      ["claude-fable-5-1[1m]", "Fable 5.1 (1M context)"],
    ]);
    expect(models.filter(model => model.isDefault).map(model => model.id)).toEqual(["claude-fable-5-1"]);
    // The table is a fresh copy each call, so a caller cannot corrupt it.
    models[0].name = "Changed";
    expect((await readClaudeModels())[0].name).toBe("Fable 5.1");
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
