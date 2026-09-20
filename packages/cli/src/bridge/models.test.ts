import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeName, ModelCatalog, readClaudeModels } from "./models.js";

describe("model catalogue", () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

  it("names Claude ids the way the menu does", () => {
    expect(claudeName("claude-fable-5-1")).toBe("Fable 5.1");
    expect(claudeName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(claudeName("claude-opus-5[1m]")).toBe("Opus 5 (1M context)");
    expect(claudeName("sonnet")).toBe("Sonnet");
  });

  it("lists Claude aliases, the models this computer ran, and the configured one", async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-models-"));
    const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = root;
    try {
      const project = path.join(root, "projects/-home-sam-app"); await mkdir(project, { recursive: true });
      await writeFile(path.join(project, "a.jsonl"), [
        { type: "assistant", message: { model: "claude-sonnet-5", role: "assistant", content: "hi" } },
        { type: "assistant", message: { model: "claude-sonnet-5", role: "assistant", content: "again" } },
        { type: "assistant", message: { model: "claude-fable-5-1", role: "assistant", content: "hi" } },
      ].map(JSON.stringify).join("\n") + "\n");
      await writeFile(path.join(root, "settings.json"), JSON.stringify({ model: "claude-fable-5-1[1m]" }));
      const models = await readClaudeModels();
      expect(models.map(m => m.id)).toEqual(["fable", "opus", "sonnet", "haiku", "claude-sonnet-5", "claude-fable-5-1", "claude-fable-5-1[1m]"]);
      expect(models.find(m => m.id === "claude-fable-5-1[1m]")).toMatchObject({ name: "Fable 5.1 (1M context)", isDefault: true });
      expect(models.find(m => m.id === "claude-sonnet-5")).toMatchObject({ name: "Sonnet 5" });
    } finally { process.env.CLAUDE_CONFIG_DIR = old; }
  });

  it("caches per source and never lists a provider it does not know", async () => {
    let calls = 0;
    const catalog = new ModelCatalog(async () => { calls++; return [{ id: "gpt-x", name: "X" }]; }, async () => []);
    expect(await catalog.list("codex")).toEqual([{ id: "gpt-x", name: "X" }]);
    expect(await catalog.list("codex")).toEqual([{ id: "gpt-x", name: "X" }]);
    expect(calls).toBe(1);
    expect(await catalog.list("opencode")).toEqual([]);
  });
});
