import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountLabel, clearAccountCaches } from "./claude-accounts.js";
import { addClaudeAccount, sshKeychainState, suggestAccountSlug, syncAccountMcpServers } from "./claude-account-setup.js";

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
  // 2026-10-27: `phren bridge accounts add Buildbox` only said the name was bad.
  await expect(addClaudeAccount("Buildbox")).rejects.toThrow(/Try "buildbox"\./);
  await expect(addClaudeAccount("Buildbox", { label: "Sam.Lee@Example.com" })).rejects.toThrow(/Try "sam-lee-example"\./);
  expect(suggestAccountSlug("My Work Box")).toBe("my-work-box");
  expect(suggestAccountSlug("x", "sam@mail.com")).toBe("sam-mail");
  expect(suggestAccountSlug("--")).toBe("account");
  expect(suggestAccountSlug("Default")).toBe("default-2");
  expect(suggestAccountSlug("a".repeat(31) + " b")).toBe("a".repeat(31));
  for (const name of ["Buildbox", "My Work Box", "--", "Default", "a".repeat(40)]) expect(/^[a-z0-9][a-z0-9-]{0,31}$/.test(suggestAccountSlug(name))).toBe(true);
});

it("says plainly when an ssh session can't use the Mac's keychain, and makes nothing", async () => {
  const locked = async () => "locked" as const;
  await expect(addClaudeAccount("work", { keychainState: locked })).rejects.toThrow(
    "This Mac's login keychain is locked to this ssh session, so Claude can't save a login made here. On the Mac itself, run: phren bridge accounts add work.");
  expect(() => lstatSync(path.join(home, ".claude-work"))).toThrow();
  await expect(addClaudeAccount("work", { label: "Bob's", keychainState: locked })).rejects.toThrow("run: phren bridge accounts add work --label 'Bob'\\''s'.");
  // An existing home only has its links and label refreshed, which needs no keychain.
  await addClaudeAccount("work");
  expect(await addClaudeAccount("work", { label: "Work", keychainState: locked })).not.toHaveProperty("warning");
});

it("goes ahead with a warning when the keychain check itself fails", async () => {
  const added = await addClaudeAccount("work", { keychainState: async () => "unknown" });
  expect(added).toMatchObject({ created: true, warning: expect.stringContaining("Couldn't check this Mac's login keychain") });
  expect(lstatSync(path.join(home, ".claude-work")).isDirectory()).toBe(true);
});

it("calls a keychain locked only on the keychain's own refusal", async () => {
  // Shaped like execFile's rejections.
  const fails = (error: object) => async () => { throw Object.assign(new Error("Command failed: security show-keychain-info"), error); };
  const ssh = { SSH_CONNECTION: "100.64.0.2 52000 100.64.0.1 22" };
  expect(await sshKeychainState(ssh, "darwin", fails({ stderr: "security: SecKeychainCopySettings login.keychain-db: User interaction is not allowed.\n" }))).toBe("locked");
  expect(await sshKeychainState(ssh, "darwin", async () => ({ stdout: "Keychain \"login.keychain-db\" no-timeout\n" }))).toBe("usable");
  // The 5 s timeout kills the probe; a missing binary never spawns; anything else is not a lock either.
  expect(await sshKeychainState(ssh, "darwin", fails({ killed: true, signal: "SIGTERM", stderr: "" }))).toBe("unknown");
  expect(await sshKeychainState(ssh, "darwin", async () => { throw Object.assign(new Error("spawn security ENOENT"), { code: "ENOENT" }); })).toBe("unknown");
  expect(await sshKeychainState(ssh, "darwin", fails({ stderr: "security: A default keychain could not be found.\n" }))).toBe("unknown");
  // Local sessions and other systems are never checked.
  const never = async () => { throw new Error("checked"); };
  expect(await sshKeychainState({}, "darwin", never)).toBe("usable");
  expect(await sshKeychainState(ssh, "linux", never)).toBe("usable");
});
