import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearProjectConfigCache } from "../project-config.js";
import { automaticRooms, choosePolicyAccount, computerRule, policyApplies, poolRefusal, projectRule, type PolicyRoom } from "./account-policy.js";
import { chooseAccount } from "./account-choice.js";
import { policyAccount } from "./dispatch.js";
import * as harnesses from "./harnesses.js";
import type { DispatchHost } from "./dispatch-hosts.js";
import { checkMovePeer, localMoveAvailability, type MoveAvailability } from "./move-computers.js";

const room = (account: string, five: number, extra: Partial<PolicyRoom> = {}): PolicyRoom =>
  ({ account, usable: true, fiveHour: { leftPercent: five }, week: { leftPercent: 80 }, ...(five === 0 ? { exhausted: true } : {}), ...extra });
const anyPool = [{ owner: "project app" }];

describe("account choice with pools and roles", () => {
  it("changes nothing without pools, roles or API logins", () => {
    const rooms = [room("default", 40), room("work", 70)];
    expect(policyApplies(rooms, anyPool)).toBe(false);
    expect(choosePolicyAccount(rooms, anyPool).choice).toEqual(chooseAccount(rooms).choice);
  });

  it("never chooses an off account or an API account with no role automatically, but takes an API account given a role", () => {
    const rooms = [room("team", 90, { role: "off" }), room("api", 95, { console: true }), room("default", 20)];
    const { choice, skipped } = choosePolicyAccount(rooms);
    expect(choice?.account).toBe("default");
    expect(skipped).toEqual(["team: role off (chosen only by hand)", "api: an API account with no role (chosen only by hand)"]);
    expect(choice?.reason).toContain("ruled out team: role off");
    expect(choosePolicyAccount([room("api", 95, { console: true, role: "helpers" }), room("default", 20)]).choice?.account).toBe("api");
  });

  it("refuses an account outside the project's or computer's pools, and one with no pool once a list is set", () => {
    const rules = [{ owner: "project client-a", pools: ["client-a"] }, { owner: "computer Desk", pools: ["client-a", "personal"] }];
    expect(poolRefusal({ account: "big", pool: "personal" }, rules)).toBe("its pool personal is not in project client-a's allowed pools (client-a)");
    expect(poolRefusal({ account: "plain" }, rules)).toBe("it has no pool, and is not in project client-a's allowed pools (client-a)");
    expect(poolRefusal({ account: "small", pool: "client-a" }, rules)).toBeUndefined();
    const { choice } = choosePolicyAccount([room("big", 99, { pool: "personal" }), room("plain", 90), room("small", 10, { pool: "client-a" })], rules);
    expect(choice?.account).toBe("small");
    expect(choosePolicyAccount([room("big", 99, { pool: "personal" })], rules)).toEqual({ skipped: [expect.stringMatching(/^big: its pool personal/)] });
  });

  it("offers a last-resort account only when no ordinary or helpers account has room", () => {
    const spare = room("spare", 100, { role: "last-resort" });
    expect(choosePolicyAccount([spare, room("default", 5), room("api", 30, { role: "helpers" })]).choice?.account).toBe("api");
    const out = choosePolicyAccount([spare, room("default", 0), room("api", 0, { role: "helpers" })]);
    expect(out.choice?.account).toBe("spare");
    expect(out.choice?.reason).toMatch(/^last resort, no other account has room \(default: out of quota, api: out of quota\)/);
    // Held back by the limits ledger counts as no room too.
    expect(choosePolicyAccount([spare, room("default", 50)], [], target => target.account === "default" ? "hit its limit" : undefined).choice?.account).toBe("spare");
  });

  it("leaves a stopped worker's continuation only the accounts it may take automatically", () => {
    const rooms = [room("default", 0), room("spare", 80, { role: "last-resort" }), room("team", 90, { role: "off" }), room("api", 50, { pool: "personal" })];
    // default has no pool for Desk's list, team is off, and api has room, so the last-resort spare sits out.
    expect(automaticRooms(rooms, [computerRule("Desk", ["personal"])]).map(item => item.account)).toEqual(["api"]);
    // Nothing else with room: the last-resort account stays in.
    expect(automaticRooms([room("default", 0), room("spare", 80, { role: "last-resort" })], []).map(item => item.account)).toEqual(["default", "spare"]);
    expect(computerRule("Desk", ["ok", "Not OK"])).toEqual({ owner: "computer Desk", pools: ["ok"] });
    expect(computerRule("Desk", undefined)).toEqual({ owner: "computer Desk" });
  });
});

describe("pools and roles at dispatch and Continue in…", () => {
  let home = "", store = "";
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "phren-policy-"));
    store = path.join(home, "store");
    mkdirSync(path.join(store, "client-a"), { recursive: true });
    vi.stubEnv("PHREN_PATH", store); vi.stubEnv("HOME", home);
    clearProjectConfigCache();
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

  const listing = (accounts: Array<Record<string, unknown>>, allowedPools?: string[]) =>
    [{ source: "claude", installed: true, usable: true, accounts: accounts.map(item => ({ label: String(item.id), key: `claude:${item.id}`, signedIn: true, usable: true, ...item })), ...(allowedPools ? { allowedPools } : {}) }] as never;
  const usage = [{ source: "claude", account: "default", fiveHour: { leftPercent: 90 } }, { source: "claude", account: "api", fiveHour: { leftPercent: 40 } }];

  it("names the account a dispatch runs under once pools or roles apply, refuses one the pools rule out, and otherwise leaves it to the computer", () => {
    const project = projectRule(store, "client-a");
    expect(policyAccount({ harness: "claude" }, listing([{ id: "default" }, { id: "api" }]), usage, "Desk", project)).toBeUndefined();
    expect(policyAccount({ harness: "codex" }, listing([{ id: "default", role: "off" }]), usage, "Desk", project)).toBeUndefined();
    writeFileSync(path.join(store, "client-a/phren.project.yaml"), "allowedPools: [client-a]\n");
    clearProjectConfigCache();
    const pooled = projectRule(store, "client-a");
    const accounts = listing([{ id: "default", pool: "personal" }, { id: "api", pool: "client-a", role: "helpers", console: true }]);
    expect(policyAccount({ harness: "claude" }, accounts, usage, "Desk", pooled)).toMatchObject({ account: "api", reason: expect.stringContaining("ruled out default: its pool personal") });
    expect(policyAccount({ harness: "claude", account: "default" }, accounts, usage, "Desk", pooled))
      .toEqual({ refused: "Claude account default may not do this work: its pool personal is not in project client-a's allowed pools (client-a)." });
    expect(policyAccount({ harness: "claude", account: "api" }, accounts, usage, "Desk", pooled)).toBeUndefined();
    // The computer's own list counts too.
    expect(policyAccount({ harness: "claude" }, listing([{ id: "api", pool: "client-a" }], ["personal"]), usage, "Desk", pooled))
      .toEqual({ refused: expect.stringMatching(/^No Claude account there may do this work: api: its pool client-a is not in computer Desk's allowed pools \(personal\)/) });
    // An older Hook reports no pools: with a project list nothing it has can be shown to fit.
    expect(policyAccount({ harness: "claude" }, listing([{ id: "default" }]), usage, "Old", pooled)).toMatchObject({ refused: expect.stringContaining("has no pool") });
  });

  it("reports each login's pool refusal in Continue in… availability and keeps the choice to logins it allows", async () => {
    writeFileSync(path.join(store, "client-a/phren.project.yaml"), `sourcePath: ${home}\nallowedPools: [client-a]\n`);
    clearProjectConfigCache();
    vi.spyOn(harnesses, "harnessInventoryWithin").mockResolvedValue({ harnesses: listing([{ id: "default", pool: "personal" }, { id: "api", pool: "client-a", role: "helpers" }]) });
    const facts = await localMoveAvailability("client-a", async () => ({}));
    const accounts = facts.harnesses.find(row => row.source === "claude")!.accounts!;
    expect(accounts.find(login => login.id === "default")).toMatchObject({ pool: "personal", poolRefused: expect.stringContaining("project client-a's allowed pools") });
    expect(accounts.find(login => login.id === "api")).toMatchObject({ pool: "client-a", role: "helpers" });
    expect(accounts.find(login => login.id === "api")).not.toHaveProperty("poolRefused");

    const peer = (answer: MoveAvailability) => ({ name: "Desk", request: async () => ({ ...answer, computerId: "00000000-0000-4000-8000-0000000000aa" }) }) as unknown as DispatchHost;
    expect(await checkMovePeer(peer(facts), "client-a", { harness: "claude" } as never)).toMatchObject({ account: "api" });
    await expect(checkMovePeer(peer(facts), "client-a", { harness: "claude", account: "default" } as never)).rejects.toThrow(/default on Desk may not do this work: its pool personal/);
    const allOut = { ...facts, harnesses: facts.harnesses.map(row => row.source === "claude" ? { ...row, accounts: row.accounts!.map(login => ({ ...login, poolRefused: "not allowed" })) } : row) };
    await expect(checkMovePeer(peer(allOut), "client-a", { harness: "claude" } as never)).rejects.toThrow(/No Claude account on Desk may continue this/);
  });
});
