import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountLabel, clearAccountCaches } from "./claude-accounts.js";
import { addClaudeAccount, syncAccountMcpServers } from "./claude-account-setup.js";

let home = "";
// Windows reports 0666 whatever mode is asked for.
const posix = process.platform !== "win32";
const json = (file: string) => JSON.parse(readFileSync(path.join(home, file), "utf8"));
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "phren-setup-"));
  vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
  clearAccountCaches();
  mkdirSync(path.join(home, ".claude/skills"), { recursive: true });
  writeFileSync(path.join(home, ".claude/settings.json"), "{}"); writeFileSync(path.join(home, ".claude/CLAUDE.md"), "hi");
  writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "secret" }, projects: { a: 1 }, mcpServers: { phren: { command: "phren" } } }));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it("creates a private home with symlinks, only mcpServers, and a label", async () => {
  const added = await addClaudeAccount("work", { label: "Work Sub" });
  const dir = path.join(home, ".claude-work");
  expect(added.linked.sort()).toEqual(["CLAUDE.md", "settings.json", "skills"]);
  expect(readlinkSync(path.join(dir, "settings.json"))).toBe(path.join(home, ".claude/settings.json"));
  expect(() => lstatSync(path.join(dir, "agents"))).toThrow();
  if (posix) expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(json(".claude-work/.claude.json")).toEqual({ mcpServers: { phren: { command: "phren" } } });
  if (posix) expect(statSync(path.join(dir, ".claude.json")).mode & 0o777).toBe(0o600);
  expect(accountLabel("work")).toBe("Work Sub");
});

it("never overwrites existing entries and merges mcpServers with the default winning", async () => {
  const dir = path.join(home, ".claude-work");
  mkdirSync(dir, { mode: 0o755 }); writeFileSync(path.join(dir, "settings.json"), "mine");
  writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "w" }, mcpServers: { phren: { command: "old" }, extra: { command: "x" } } }));
  await addClaudeAccount("work");
  if (posix) expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(readFileSync(path.join(dir, "settings.json"), "utf8")).toBe("mine");
  expect(json(".claude-work/.claude.json")).toEqual({ oauthAccount: { accountUuid: "w" }, mcpServers: { phren: { command: "phren" }, extra: { command: "x" } } });
});

it("rejects bad slugs and syncs extra homes only", async () => {
  await expect(addClaudeAccount("default")).rejects.toThrow();
  await expect(addClaudeAccount("Bad Slug")).rejects.toThrow();
  await addClaudeAccount("work");
  writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { phren: { command: "new" } } }));
  expect(await syncAccountMcpServers()).toEqual(["work"]);
  expect(json(".claude-work/.claude.json").mcpServers).toEqual({ phren: { command: "new" } });
  expect(await syncAccountMcpServers()).toEqual([]);
});
