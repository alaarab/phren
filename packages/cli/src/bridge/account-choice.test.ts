import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { setComputerAllowedPools } from "./account-pools.js";
import { clearProjectConfigCache } from "../project-config.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountWindows, chooseAccount, claudeRooms, limitedBy, noteAccountLimit, pickClaudeAccount, setChoiceReaders, readAccountLimits, resolveAccountFailover, UNKNOWN_RESET_MS, type AccountRoom } from "./account-choice.js";
import { clearAccountCaches, claudeHomes, claudeLoginFingerprint } from "./claude-accounts.js";
import { rememberLogin, rememberPolicy, type LoginKind } from "./account-last-known.js";
import type { HarnessInventory } from "./harnesses.js";
import type { AccountUsage } from "./usage.js";

const now = Date.parse("2026-10-10T12:00:00Z");
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const room = (account: string, fiveHour?: number, week?: number, extra: Partial<AccountRoom> = {}): AccountRoom => ({ account, usable: true,
  ...(fiveHour !== undefined ? { fiveHour: { leftPercent: fiveHour, resetsAt: at(2) } } : {}),
  ...(week !== undefined ? { week: { leftPercent: week, resetsAt: at(72) } } : {}), ...extra });

describe("choosing the Claude account with the most headroom", () => {
  it.each([
    ["the most 5-hour room first, whatever the weekly room", [room("default", 20, 90), room("work", 70, 10)], "work"],
    ["the weekly room when the 5-hour rooms tie", [room("default", 50, 30), room("work", 50, 60)], "work"],
    ["default when both windows tie", [room("work", 50, 50), room("default", 50, 50)], "default"],
    ["a reported account over one never reported", [room("default"), room("work", 5, 5)], "work"],
    ["an unreported account over one with both windows exhausted", [room("default", 0, 0, { exhausted: true, until: at(2) }), room("work")], "work"],
  ])("takes %s", (_name, rooms, expected) => {
    expect(chooseAccount(rooms).choice?.account).toBe(expected);
  });

  it("never takes a signed-out account, one out of quota, or one the ledger holds back, and says why", () => {
    const { choice, skipped } = chooseAccount([room("default", 90, 90, { usable: false }), room("work", 0, 40, { exhausted: true, until: at(2) }), room("spare", 30, 30), room("held", 99, 99)],
      candidate => candidate.account === "held" ? "hit its limit" : undefined);
    expect(choice?.account).toBe("spare");
    expect(skipped).toEqual(["default: not signed in", `work: out of quota until ${at(2)}`, "held: hit its limit"]);
    expect(choice?.reason).toContain("most headroom: spare (30% 5-hour left, 30% weekly left)");
  });

  it("chooses nothing when every account is out", () => {
    expect(chooseAccount([room("default", 0, 50, { exhausted: true }), room("work", 50, 0, { exhausted: true })]).choice).toBeUndefined();
    expect(chooseAccount([]).choice).toBeUndefined();
  });

  it("reads a window whose reset has passed as full, and a refused one as empty", () => {
    const usage = { windows: [{ id: "five_hour", name: "5-hour", usedPercent: 100, resetsAt: at(-1) }, { id: "seven_day", name: "7-day", usedPercent: 40, limited: true, resetsAt: at(30) }] };
    expect(accountWindows(usage, now)).toEqual({ fiveHour: { leftPercent: 100 }, week: { leftPercent: 0, resetsAt: at(30) } });
  });

  it("joins the signed-in homes with their usage rows, marking an exhausted window", () => {
    const inventory: HarnessInventory = { harnesses: [{ source: "claude", installed: true, usable: true, accounts: [
      { id: "default", label: "Claude", key: "claude:a", signedIn: true, usable: true }, { id: "work", label: "Work", key: "claude:b", signedIn: true, usable: true }] }] };
    const usage: AccountUsage[] = [{ source: "claude", account: { id: "work", label: "Work", key: "claude:b" }, windows: [{ id: "five_hour", name: "5-hour", usedPercent: 100, resetsAt: at(3) }] }];
    expect(claudeRooms(inventory, usage, now)).toEqual([
      { account: "default", key: "claude:a", usable: true },
      { account: "work", key: "claude:b", usable: true, fiveHour: { leftPercent: 0, resetsAt: at(3) }, exhausted: true, until: at(3) }]);
  });
});

describe("the ledger of accounts that hit their limit", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "phren-account-limits-")); vi.stubEnv("PHREN_BRIDGE_HOME", root); });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it("holds a login back until its reset, or one 5-hour window when the reset is unknown, by key on every computer", async () => {
    await noteAccountLimit({ key: "claude:a", account: "default", until: at(3) }, now);
    await noteAccountLimit({ key: "Mini/work", account: "work" }, now);
    expect((await readAccountLimits(now)).map(entry => [entry.key, entry.until])).toEqual([["claude:a", at(3)], ["Mini/work", new Date(now + UNKNOWN_RESET_MS).toISOString()]]);
    const held = limitedBy(await readAccountLimits(now), "MacBook");
    expect(held({ account: "personal", key: "claude:a" })).toContain("held until");
    expect(held({ account: "work" })).toBeUndefined();
    expect(await readAccountLimits(now + 4 * 3_600_000)).toEqual([{ key: "Mini/work", account: "work", until: new Date(now + UNKNOWN_RESET_MS).toISOString(), at: new Date(now).toISOString() }]);
  });
});

describe("a launch that names no account, under pools and roles", () => {
  let root: string, store: string;
  const usage = (id: string, used: number): AccountUsage => ({ source: "claude", account: { id, label: id, key: id }, windows: [{ id: "five_hour", name: "5-hour", usedPercent: used, resetsAt: at(2) }] });
  const inventory = (): HarnessInventory => ({ harnesses: [{ source: "claude", installed: true, usable: true, accounts: [
    { id: "default", label: "Claude", key: "k1", signedIn: true, usable: true, pool: "personal" },
    { id: "client", label: "Client", key: "k2", signedIn: true, usable: true, pool: "client-a" },
    { id: "api", label: "API", key: "k3", signedIn: true, usable: true, pool: "client-a", role: "last-resort" },
    { id: "spare", label: "Spare", key: "k4", signedIn: true, usable: true, role: "off" }] }] });
  const pools = (project: string, list: string[]) => { mkdirSync(path.join(store, project), { recursive: true }); writeFileSync(path.join(store, project, "phren.project.yaml"), `allowedPools: [${list.join(", ")}]\n`); clearProjectConfigCache(); };
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "phren-pick-")); store = path.join(root, "store"); mkdirSync(store);
    vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge"));
    setChoiceReaders({ usage: async () => [usage("default", 0), usage("client", 70), usage("api", 0), usage("spare", 0)], inventory: async () => inventory() });
  });
  afterEach(() => { setChoiceReaders({}); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it("keeps to the project's pools, never picks off, and takes a last-resort account only when nothing else has room", async () => {
    pools("client-a", ["client-a"]);
    expect(await pickClaudeAccount("Launch", { project: "client-a", phrenPath: store }, "Mini", now)).toMatchObject({ account: "client" });
    setChoiceReaders({ usage: async () => [usage("default", 0), usage("client", 100), usage("api", 50)], inventory: async () => inventory() });
    expect(await pickClaudeAccount("Launch", { project: "client-a", phrenPath: store }, "Mini", now)).toMatchObject({ account: "api", reason: expect.stringContaining("last resort") });
    // No project rule: most room among the automatic accounts, `spare` (off) never.
    const free = await pickClaudeAccount("Launch", { phrenPath: store }, "Mini", now);
    expect(free).toMatchObject({ account: "default", reason: expect.stringContaining("spare: role off") });
  });

  it("answers 409 account_pool when no account may do the project's work, the computer's pools included", async () => {
    pools("client-b", ["client-b"]);
    await expect(pickClaudeAccount("Launch", { project: "client-b", phrenPath: store }, "Mini", now)).rejects.toMatchObject({ status: 409, details: { code: "account_pool" } });
    await setComputerAllowedPools(["personal"]);
    pools("client-a", ["client-a"]);
    setChoiceReaders({ usage: async () => [], inventory: async () => ({ harnesses: [{ ...inventory().harnesses[0], allowedPools: ["personal"] }] }) });
    await expect(pickClaudeAccount("Launch", { project: "client-a", phrenPath: store }, "Mini", now)).rejects.toThrow(/No Claude account on Mini may do this work/);
  });
});

describe("a launch whose account restrictions cannot be read", () => {
  let root: string, bridge: string;
  const restrictive = (text: string) => writeFileSync(path.join(bridge, "accounts.yaml"), text);
  const usage = (id: string, used: number): AccountUsage => ({ source: "claude", account: { id, label: id, key: id }, windows: [{ id: "five_hour", name: "5-hour", usedPercent: used, resetsAt: at(2) }] });
  const listing = (accounts: Array<Record<string, unknown>>): HarnessInventory => ({ harnesses: [{ source: "claude", installed: true, usable: true,
    accounts: accounts.map(item => ({ label: String(item.id), key: `claude:${item.id}`, signedIn: true, usable: true, ...item })) }] });
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "phren-pick-unread-")); bridge = path.join(root, "bridge"); mkdirSync(bridge);
    vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
    setChoiceReaders({ usage: async () => [] });
  });
  afterEach(() => { vi.useRealTimers(); setChoiceReaders({}); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it.each([
    ["a role off", "slots:\n  default:\n    role: off\n"],
    ["the computer's pools", "allowedPools: [personal]\n"],
  ])("refuses when the inventory rejects and accounts.yaml sets %s", async (_name, yaml) => {
    restrictive(yaml);
    setChoiceReaders({ usage: async () => [], inventory: async () => { throw new Error("probe failed"); } });
    await expect(pickClaudeAccount("Launch", {}, "Mini", now)).rejects.toMatchObject({ status: 409, details: { code: "account_pool" } });
  });

  it("refuses when the inventory times out and accounts.yaml sets a role", async () => {
    restrictive("slots:\n  default:\n    role: off\n");
    setChoiceReaders({ usage: async () => [], inventory: () => new Promise<HarnessInventory | undefined>(() => {}) });
    await expect(pickClaudeAccount("Launch", {}, "Mini", now)).rejects.toMatchObject({ status: 409, details: { code: "account_pool" } });
  });

  it("enforces the last-known role when accounts.yaml cannot be read", async () => {
    await rememberPolicy({ settings: { default: { role: "off" } } });
    restrictive("[not, a, mapping]\n");
    setChoiceReaders({ usage: async () => [], inventory: async () => listing([{ id: "default" }]) });
    await expect(pickClaudeAccount("Launch", {}, "Mini", now)).rejects.toMatchObject({ status: 409, details: { code: "account_pool" } });
  });

  it("enforces the last-known pools when accounts.yaml cannot be read", async () => {
    await rememberPolicy({ settings: { default: { pool: "personal" }, client: { pool: "client-a" } }, allowedPools: ["client-a"] });
    restrictive("[not, a, mapping]\n");
    setChoiceReaders({ usage: async () => [usage("default", 0), usage("client", 0)], inventory: async () => listing([{ id: "default" }, { id: "client" }]) });
    expect(await pickClaudeAccount("Launch", {}, "Mini", now)).toMatchObject({ account: "client" });
  });

  it("refuses when a last-known restriction cannot be evaluated because the inventory did not answer", async () => {
    await rememberPolicy({ settings: { default: { role: "off" } } });
    restrictive("[not, a, mapping]\n");
    setChoiceReaders({ usage: async () => [], inventory: async () => undefined });
    await expect(pickClaudeAccount("Launch", {}, "Mini", now)).rejects.toMatchObject({ status: 409, details: { code: "account_pool" } });
  });

  it.each([
    ["none was ever parsed", async () => {}],
    ["the last parsed policy never restricted", async () => { await rememberPolicy({ settings: {} }); }],
  ])("launches when accounts.yaml cannot be read and %s", async (_name, remembered) => {
    await remembered();
    restrictive("[not, a, mapping]\n");
    setChoiceReaders({ usage: async () => [usage("default", 0), usage("work", 50)], inventory: async () => listing([{ id: "default" }, { id: "work" }]) });
    await expect(pickClaudeAccount("Launch", {}, "Mini", now)).resolves.toMatchObject({ account: "default" });
  });

  it("still launches as before when nothing restricts the account", async () => {
    setChoiceReaders({ usage: async () => [], inventory: async () => undefined });
    expect(await pickClaudeAccount("Launch", {}, "Mini", now)).toBeUndefined();
  });
});

describe("the sole Claude account with no pools or role", () => {
  let home: string, bin: string;
  const claude = (auth: string) => writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nprintf '%s' '${auth}'\n`, { mode: 0o755 });
  const defaultHome = () => claudeHomes().find(item => item.id === "default")!;
  const remember = async (kind: LoginKind) => {
    const home = defaultHome();
    await rememberLogin(home, claudeLoginFingerprint(home), kind);
  };
  const identify = (uuid: string) => writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: uuid } }));
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "phren-pick-sole-")); bin = path.join(home, "bin"); mkdirSync(bin);
    mkdirSync(path.join(home, ".claude"));
    vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
    vi.stubEnv("PATH", bin);
    clearAccountCaches();
    // Only the usage reader: injecting an inventory would disable the shortcut under test.
    setChoiceReaders({ usage: async () => [] });
  });
  afterEach(() => { setChoiceReaders({}); vi.unstubAllEnvs(); clearAccountCaches(); rmSync(home, { recursive: true, force: true }); });

  it("refuses a lone Console login with no role instead of launching under it", async () => {
    claude('{"loggedIn":true,"authMethod":"console"}');
    await expect(pickClaudeAccount("Launch", {}, "Mini", now)).rejects.toMatchObject({ status: 409, details: { code: "account_pool" } });
  });

  it("still takes the shortcut for a lone subscription login", async () => {
    claude('{"loggedIn":true,"subscriptionType":"max"}');
    expect(await pickClaudeAccount("Launch", {}, "Mini", now)).toBeUndefined();
  });

  it("refuses when the probe is unknown and the last-known login was Console", async () => {
    identify("login-console"); await remember("console");
    claude("not json");
    await expect(pickClaudeAccount("Launch", {}, "Mini", now)).rejects.toMatchObject({ status: 409, details: { code: "account_pool" } });
  });

  it("proceeds when the probe is unknown and no login is known yet", async () => {
    claude("not json");
    expect(await pickClaudeAccount("Launch", {}, "Mini", now)).toBeUndefined();
  });

  it("bounds a stalled login probe and falls back to the last-known login", async () => {
    identify("login-subscription"); await remember("subscription");
    writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n/bin/sleep 4\n", { mode: 0o755 });
    const started = Date.now();
    expect(await pickClaudeAccount("Launch", {}, "Mini", now)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3_500);
  });

  it("launches when accounts.yaml cannot be read and no restriction was ever known", async () => {
    await rememberPolicy({ settings: {} });
    writeFileSync(path.join(home, "bridge", "accounts.yaml"), "[not, a, mapping]\n");
    claude('{"loggedIn":true,"subscriptionType":"max"}');
    expect(await pickClaudeAccount("Launch", {}, "Mini", now)).toBeUndefined();
  });

  it("refuses a Console login after a cached subscription answer", async () => {
    identify("login-subscription"); claude('{"loggedIn":true,"subscriptionType":"max"}');
    expect(await pickClaudeAccount("Launch", {}, "Mini", now)).toBeUndefined();
    identify("login-console-changed"); claude('{"loggedIn":true,"authMethod":"console"}');
    await expect(pickClaudeAccount("Launch", {}, "Mini", now)).rejects.toMatchObject({ status: 409, details: { code: "account_pool" } });
  });

  it("proceeds after switching from a cached Console login to a subscription", async () => {
    identify("login-console"); claude('{"loggedIn":true,"authMethod":"console"}');
    await expect(pickClaudeAccount("Launch", {}, "Mini", now)).rejects.toMatchObject({ status: 409, details: { code: "account_pool" } });
    identify("login-subscription-changed"); claude('{"loggedIn":true,"subscriptionType":"max"}');
    expect(await pickClaudeAccount("Launch", {}, "Mini", now)).toBeUndefined();
  });

  it("keeps a last-known Console classification when only the config's project settings change", async () => {
    identify("login-console");
    writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }));
    await remember("console");
    // A folder-trust prompt or project setting rewrites .claude.json; the login did not change.
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "login-console" }, projects: { "/tmp/project": { hasTrustDialogAccepted: true } } }));
    claude("not json");
    await expect(pickClaudeAccount("Launch", {}, "Mini", now)).rejects.toMatchObject({ status: 409, details: { code: "account_pool" } });
  });

  it("reclassifies when the identity changes", async () => {
    identify("login-console"); await remember("console");
    identify("login-subscription-changed"); claude("not json");
    expect(await pickClaudeAccount("Launch", {}, "Mini", now)).toBeUndefined();
  });
});

describe("last-known logins with more than one home", () => {
  let home: string;
  const usage = (id: string, used: number): AccountUsage => ({ source: "claude", account: { id, label: id, key: id }, windows: [{ id: "five_hour", name: "5-hour", usedPercent: used, resetsAt: at(2) }] });
  const unknown = (ids: readonly string[]): HarnessInventory => ({ harnesses: [{ source: "claude", installed: true, usable: true,
    accounts: ids.map(id => ({ id, label: id, key: `claude:${id}`, signedIn: false, usable: true, reason: "Claude did not report its sign-in state" })) }] });
  const homeOf = (id: string) => claudeHomes().find(item => item.id === id)!;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "phren-pick-many-"));
    mkdirSync(path.join(home, ".claude")); writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "default-login" } }));
    mkdirSync(path.join(home, ".claude-work")); writeFileSync(path.join(home, ".claude-work", ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "work-login" } }));
    vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
    clearAccountCaches();
    setChoiceReaders({ usage: async () => [usage("default", 0), usage("work", 0)], inventory: async () => unknown(["default", "work"]) });
  });
  afterEach(() => { setChoiceReaders({}); vi.unstubAllEnvs(); clearAccountCaches(); rmSync(home, { recursive: true, force: true }); });

  it("skips a home whose live answer is unknown but whose last login was Console", async () => {
    const work = homeOf("work");
    await rememberLogin(work, claudeLoginFingerprint(work), "console");
    expect(await pickClaudeAccount("Launch", {}, "Mini", now)).toMatchObject({ account: "default" });
  });

  it("refuses a default fallback when the inventory times out and default's last login was Console", async () => {
    const def = homeOf("default");
    await rememberLogin(def, claudeLoginFingerprint(def), "console");
    setChoiceReaders({ usage: async () => [], inventory: () => new Promise<HarnessInventory | undefined>(() => {}) });
    await expect(pickClaudeAccount("Launch", {}, "Mini", now)).rejects.toMatchObject({ status: 409, details: { code: "account_pool" } });
  });
});

describe("the last-known account file", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "phren-last-known-")); vi.stubEnv("PHREN_BRIDGE_HOME", root); });
  afterEach(() => { vi.resetModules(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it("keeps a classification and a policy written at the same time", async () => {
    const first = await import("./account-last-known.js");
    vi.resetModules();
    const second = await import("./account-last-known.js");
    const dir = path.join(root, "home"); mkdirSync(dir);
    const configFile = path.join(dir, ".claude.json"); writeFileSync(configFile, JSON.stringify({ oauthAccount: { accountUuid: "one" } }));
    const home = { id: "default", dir, configFile, isDefault: true };
    const fingerprint = claudeLoginFingerprint(home);
    await Promise.all([
      first.rememberPolicy({ settings: { default: { role: "off" } } }),
      second.rememberLogin(home, fingerprint, "console"),
    ]);
    const known = await first.readLastKnown();
    expect(known.policy).toEqual({ settings: { default: { role: "off" } } });
    expect(known.logins).toEqual({ default: { kind: "console", fingerprint } });
  });
});

describe("the account-failover switch", () => {
  it("is off until the owner opts in, and follows PHREN_ACCOUNT_FAILOVER", () => {
    expect(resolveAccountFailover({}, null)).toEqual({ on: false, source: "default" });
    expect(resolveAccountFailover({ PHREN_ACCOUNT_FAILOVER: "on" }, null)).toEqual({ on: true, source: "PHREN_ACCOUNT_FAILOVER" });
  });
});
