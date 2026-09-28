import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountLabel, claudeAccountKey, claudeAccountRef, claudeHome, claudeHomeOfEnv, claudeHomeOfPath, claudeHomes, claudeLaunchEnv, clearAccountCaches, parseAuthStatus, setAccountLabel } from "./claude-accounts.js";

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

it("parses claude auth status output", () => {
  expect(parseAuthStatus('{"loggedIn":true,"subscriptionType":"max","email":"x"}')).toEqual({ signedIn: true, plan: "max" });
  expect(parseAuthStatus('{"loggedIn":true}')).toEqual({ signedIn: true });
  expect(parseAuthStatus('{"loggedIn":false}')).toMatchObject({ signedIn: false, reason: "Not signed in" });
  expect(parseAuthStatus("not json")).toMatchObject({ signedIn: false });
  expect(parseAuthStatus("")).toMatchObject({ signedIn: false });
});
