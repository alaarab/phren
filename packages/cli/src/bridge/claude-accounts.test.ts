import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountLabel, claudeAccountKey, claudeAccountSubscription, claudeAuthKill, claudeAuthSpawn, claudePlanUnknown, claudeAccountRef, claudeHome, claudeHomeOfEnv, claudeHomeOfPath, claudeHomes, claudeLaunchEnv, clearAccountCaches, parseAuthStatus, setAccountLabel } from "./claude-accounts.js";

let home = "";
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "phren-accounts-"));
  vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
  clearAccountCaches();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

const account = (name: string, config: unknown = {}) => {
  mkdirSync(path.join(home, name), { recursive: true });
  writeFileSync(path.join(home, name, ".claude.json"), JSON.stringify(config));
};

it("discovers homes by the ~/.claude-<slug> rule and ignores the rest", () => {
  account(".claude-work"); account(".claude-Bad"); mkdirSync(path.join(home, ".claude-x"));
  expect(claudeHomes().map(h => h.id)).toEqual(["default", "work"]);
  const [def, work] = claudeHomes();
  expect(def).toMatchObject({ dir: path.join(home, ".claude"), configFile: path.join(home, ".claude.json"), isDefault: true });
  expect(work).toMatchObject({ dir: path.join(home, ".claude-work"), configFile: path.join(home, ".claude-work", ".claude.json"), isDefault: false });
  expect(claudeHome("work")?.id).toBe("work");
  expect(claudeHome("nope")).toBeUndefined();
});

it("treats a CLAUDE_CONFIG_DIR override as the default home", () => {
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, "moved"));
  const [def] = claudeHomes();
  expect(def.dir).toBe(path.join(home, "moved"));
  expect(def.configFile).toBe(path.join(home, "moved", ".claude.json"));
});

it("maps paths and environments to homes, and launches only extra homes with CLAUDE_CONFIG_DIR", () => {
  account(".claude-work");
  expect(claudeHomeOfPath(path.join(home, ".claude-work/projects/a/s.jsonl"))?.id).toBe("work");
  expect(claudeHomeOfPath(path.join(home, ".claude/projects/a/s.jsonl"))?.id).toBe("default");
  expect(claudeHomeOfPath(path.join(home, "elsewhere/s.jsonl"))).toBeUndefined();
  expect(claudeHomeOfEnv(undefined)?.id).toBe("default");
  expect(claudeHomeOfEnv(path.join(home, ".claude-work"))?.id).toBe("work");
  expect(claudeLaunchEnv(claudeHome("default")!)).toEqual({});
  expect(claudeLaunchEnv(claudeHome("work")!)).toEqual({ CLAUDE_CONFIG_DIR: path.join(home, ".claude-work") });
});

it("reads and writes labels, with title-cased fallbacks", async () => {
  expect(accountLabel("default")).toBe("Claude");
  expect(accountLabel("work-team")).toBe("Work Team");
  await setAccountLabel("work", "Job");
  await setAccountLabel("default", "Personal");
  expect(accountLabel("work")).toBe("Job");
  expect(accountLabel("default")).toBe("Personal");
  await expect(setAccountLabel("Bad Slug", "x")).rejects.toThrow();
  await expect(setAccountLabel("work", " ")).rejects.toThrow();
});

it("keys an account by a hash of its accountUuid, else by its home", () => {
  account(".claude-work", { oauthAccount: { accountUuid: "abc-123", emailAddress: "x@y.z" } }); account(".claude-other");
  const key = claudeAccountKey(claudeHome("work")!);
  expect(key).toMatch(/^claude:[0-9a-f]{12}$/);
  expect(claudeAccountKey(claudeHome("work")!)).toBe(key);
  expect(key).not.toContain("abc-123");
  expect(claudeAccountKey(claudeHome("other")!)).toBe("claude:home:other");
  expect(claudeAccountRef(claudeHome("work")!)).toEqual({ id: "work", label: "Work", key });
});

it("keys one login in two organizations as two accounts, and the same login and organization as one", () => {
  account(".claude-team", { oauthAccount: { accountUuid: "abc-123", emailAddress: "x@y.z", organizationUuid: "org-team" } });
  account(".claude-max", { oauthAccount: { accountUuid: "abc-123", emailAddress: "x@y.z", organizationUuid: "org-personal" } });
  account(".claude-again", { oauthAccount: { accountUuid: "abc-123", emailAddress: "x@y.z", organizationUuid: "org-team" } });
  account(".claude-email", { oauthAccount: { emailAddress: "x@y.z", organizationUuid: "org-team" } });
  const key = (id: string) => claudeAccountKey(claudeHome(id)!);
  expect(key("team")).not.toBe(key("max"));
  expect(key("team")).toBe(key("again"));
  expect(key("email")).toMatch(/^claude:[0-9a-f]{12}$/);
  expect(key("team")).not.toContain("org-team");
});

it("dates a Claude subscription by the profile fetch and falls back to Claude Code's plan", () => {
  account(".claude-team", { oauthAccount: { accountUuid: "a", organizationType: "claude_team", organizationRateLimitTier: "default_raven", profileFetchedAt: Date.parse("2026-10-01T00:00:00Z") } });
  account(".claude-bare", { oauthAccount: { accountUuid: "b" } });
  const now = new Date("2026-10-11T00:00:00Z");
  expect(claudeAccountSubscription(claudeHome("team")!, now)).toEqual({ plan: "Team", checkedAt: "2026-10-01T00:00:00.000Z" });
  expect(claudePlanUnknown(claudeHome("team")!)).toBe(false);
  expect(claudePlanUnknown(claudeHome("bare")!)).toBe(true);
  expect(claudeAccountSubscription(claudeHome("bare")!, now)).toBeUndefined();
  expect(claudeAccountSubscription(claudeHome("bare")!, now, "Console")).toEqual({ plan: "Console", checkedAt: now.toISOString() });
});

it("parses claude auth status output", () => {
  expect(parseAuthStatus('{"loggedIn":true,"authMethod":"console"}')).toEqual({ signedIn: true, console: true });
  expect(parseAuthStatus('{"loggedIn":true,"subscriptionType":"max","email":"x"}')).toEqual({ signedIn: true, plan: "max" });
  expect(parseAuthStatus('{"loggedIn":true}')).toEqual({ signedIn: true });
  expect(parseAuthStatus('{"loggedIn":false}')).toMatchObject({ signedIn: false, reason: "Not signed in" });
  expect(parseAuthStatus('{"loggedIn":false}').unknown).toBeUndefined();
  expect(parseAuthStatus("not json")).toMatchObject({ signedIn: false, unknown: true });
  expect(parseAuthStatus("")).toMatchObject({ signedIn: false });
});

it("starts the auth probe through a shell on Windows, where an npm install is claude.cmd", () => {
  expect(claudeAuthSpawn("win32")).toEqual({ command: "claude", shell: true });
  expect(claudeAuthSpawn("darwin")).toEqual({ command: "claude", shell: false });
  expect(claudeAuthSpawn("linux")).toEqual({ command: "claude", shell: false });
});

it("kills the auth probe's whole tree with taskkill on Windows", () => {
  const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
  let onError: (() => void) | undefined;
  const child = { pid: 4321, kill: vi.fn(() => true) };
  const run = ((command: string, args: readonly string[], options: object) => {
    calls.push({ command, args, options });
    return { on: (_event: string, listener: () => void) => { onError = listener; return {}; } };
  }) as Parameters<typeof claudeAuthKill>[2];
  claudeAuthKill(child, "win32", run, { SystemRoot: "D:\\Windows" });
  expect(calls).toEqual([{ command: "D:\\Windows\\System32\\taskkill.exe", args: ["/pid", "4321", "/T", "/F"], options: { stdio: "ignore", windowsHide: true } }]);
  expect(child.kill).not.toHaveBeenCalled();
  onError?.();
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});

it("kills the auth probe directly off Windows, where the child is claude itself", () => {
  const run = vi.fn();
  const child = { pid: 4321, kill: vi.fn(() => true) };
  claudeAuthKill(child, "linux", run as never);
  expect(run).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});
