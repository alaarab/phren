import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountLabel, clearAccountCaches } from "./claude-accounts.js";
import { addClaudeAccount, sshKeychainLocked, suggestAccountSlug, syncAccountMcpServers } from "./claude-account-setup.js";

let home = "";
// Windows reports 0666 whatever mode is asked for.
const posix = process.platform !== "win32";
const json = (file: string) => JSON.parse(readFileSync(path.join(home, file), "utf8"));
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "phren-setup-"));
  vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
  // A run over ssh would otherwise ask the real keychain.
  vi.stubEnv("SSH_CONNECTION", ""); vi.stubEnv("SSH_CLIENT", "");
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

it("answers a bad slug with one that works, from the account's email when known", async () => {
  // 2026-10-27: `phren bridge accounts add Linuxbox` only said the name was bad.
  await expect(addClaudeAccount("Linuxbox")).rejects.toThrow(/Try "linuxbox"\./);
  await expect(addClaudeAccount("Linuxbox", { label: "Ala.Arab@AlaArab.com" })).rejects.toThrow(/Try "ala-arab-alaarab"\./);
  expect(suggestAccountSlug("My Work Box")).toBe("my-work-box");
  expect(suggestAccountSlug("x", "ala@gmail.com")).toBe("ala-gmail");
  expect(suggestAccountSlug("--")).toBe("account");
  expect(suggestAccountSlug("Default")).toBe("default-2");
  expect(suggestAccountSlug("a".repeat(31) + " b")).toBe("a".repeat(31));
  for (const name of ["Linuxbox", "My Work Box", "--", "Default", "a".repeat(40)]) expect(/^[a-z0-9][a-z0-9-]{0,31}$/.test(suggestAccountSlug(name))).toBe(true);
});

it("says plainly when an ssh session can't use the Mac's keychain, and makes nothing", async () => {
  await expect(addClaudeAccount("work", { keychainLocked: async () => true })).rejects.toThrow(
    "This Mac's login keychain is locked to this ssh session, so Claude can't save a login made here. On the Mac itself, run: phren bridge accounts add work.");
  expect(() => lstatSync(path.join(home, ".claude-work"))).toThrow();
  await expect(addClaudeAccount("work", { label: "Bob's", keychainLocked: async () => true })).rejects.toThrow("run: phren bridge accounts add work --label 'Bob'\\''s'.");
  // An existing home only has its links and label refreshed, which needs no keychain.
  await addClaudeAccount("work");
  expect((await addClaudeAccount("work", { label: "Work", keychainLocked: async () => true })).created).toBe(false);

  const answers = (ok: boolean) => async () => { if (!ok) throw new Error("User interaction is not allowed."); };
  const ssh = { SSH_CONNECTION: "100.64.0.2 52000 100.64.0.1 22" };
  expect(await sshKeychainLocked(ssh, "darwin", answers(false))).toBe(true);
  expect(await sshKeychainLocked(ssh, "darwin", answers(true))).toBe(false);
  // Local sessions and other systems are never checked.
  const never = async () => { throw new Error("checked"); };
  expect(await sshKeychainLocked({}, "darwin", never)).toBe(false);
  expect(await sshKeychainLocked(ssh, "linux", never)).toBe(false);
});
