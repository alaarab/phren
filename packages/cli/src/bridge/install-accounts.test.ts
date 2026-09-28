import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAccountCaches } from "./claude-accounts.js";
import { planAgentHooks } from "./install.js";

let home = "";
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "phren-install-accounts-"));
  vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("CODEX_HOME", path.join(home, ".codex")); vi.stubEnv("COPILOT_HOME", path.join(home, ".copilot"));
  clearAccountCaches();
  mkdirSync(path.join(home, ".claude"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

const home_ = (name: string, settings?: "file" | "link") => {
  const dir = path.join(home, name);
  mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, ".claude.json"), "{}");
  if (settings === "file") writeFileSync(path.join(dir, "settings.json"), '{"theme":"dark"}');
  if (settings === "link") symlinkSync(path.join(home, ".claude/settings.json"), path.join(dir, "settings.json"));
  return dir;
};
const claudeFiles = async (remove = false) => (await planAgentHooks("/x/bridge-hook.mjs", remove)).map(e => e.file).filter(f => f.endsWith("settings.json"));

it("plans Claude hooks for every home with a real or absent settings.json and skips symlinks", async () => {
  writeFileSync(path.join(home, ".claude/settings.json"), "{}");
  const work = home_(".claude-work", "file"), fresh = home_(".claude-fresh"), shared = home_(".claude-shared", "link");
  const files = await claudeFiles();
  expect(files).toContain(path.join(home, ".claude/settings.json"));
  expect(files).toContain(path.join(work, "settings.json"));
  expect(files).toContain(path.join(fresh, "settings.json"));
  expect(files).not.toContain(path.join(shared, "settings.json"));
  const edit = (await planAgentHooks("/x/bridge-hook.mjs")).find(e => e.file === path.join(work, "settings.json"))!;
  expect(JSON.parse(edit.after)).toMatchObject({ theme: "dark", hooks: { SessionStart: [expect.anything()] } });
});

it("removal only touches homes that hold the hooks", async () => {
  home_(".claude-work", "file");
  expect(await claudeFiles(true)).toEqual([]);
});

it("still refuses a symlinked default settings.json", async () => {
  writeFileSync(path.join(home, "real.json"), "{}");
  symlinkSync(path.join(home, "real.json"), path.join(home, ".claude/settings.json"));
  await expect(planAgentHooks("/x/bridge-hook.mjs")).rejects.toThrow(/manual update/);
});
