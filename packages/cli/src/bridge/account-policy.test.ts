import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearProjectConfigCache } from "../project-config.js";
import { allowedRooms, choosePolicyAccount, computerRule, openRoom, policyApplies, poolRefusal, projectRule, type PolicyRoom } from "./account-policy.js";
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

  it("keeps only the accounts an automatic choice may take, and says which have room", () => {
    const rooms = [room("default", 0), room("spare", 80, { role: "last-resort" }), room("team", 90, { role: "off" }), room("api", 50, { pool: "personal" })];
    // default has no pool for Desk's list and team is off.
    expect(allowedRooms(rooms, [computerRule("Desk", ["personal"])]).map(item => item.account)).toEqual(["api"]);
    expect(rooms.filter(item => openRoom(item, held => held.account === "api")).map(item => item.account)).toEqual(["spare", "team"]);
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
    // Accounts not reported at all: refused under a project list, left alone without one.
    expect(policyAccount({ harness: "claude" }, undefined, usage, "Slow", pooled)).toEqual({ refused: expect.stringMatching(/did not report its Claude accounts, so project client-a's allowed pools can't be checked/) });
    expect(policyAccount({ harness: "claude" }, undefined, usage, "Slow", project)).toBeUndefined();
    // A computer whose accounts.yaml can't be read lets no account be chosen there.
    const unreadable = [{ ...(listing([{ id: "default" }]) as unknown as Array<Record<string, unknown>>)[0], poolsUnreadable: true }] as never;
    expect(policyAccount({ harness: "claude" }, unreadable, usage, "Desk", project)).toMatchObject({ refused: expect.stringContaining("computer Desk (its accounts.yaml can't be read)") });
    // A project config that can't be read allows no pool rather than any.
    writeFileSync(path.join(store, "client-a/phren.project.yaml"), "allowedPools: [unclosed\n");
    expect(projectRule(store, "client-a")).toEqual({ owner: "project client-a (its phren.project.yaml can't be read)", pools: [] });
    // A broken file that never named a list had none: nothing changes for it.
    writeFileSync(path.join(store, "client-a/phren.project.yaml"), "sourcePath: [unclosed\n");
    expect(projectRule(store, "client-a")).toEqual({ owner: "project client-a" });
    // Long lists are cut so the refusal always fits where it is carried.
    expect(poolRefusal({ account: "a", pool: "x" }, [{ owner: "project p", pools: Array.from({ length: 32 }, (_, index) => `pool-number-${index}-with-a-long-name`) }])!.length).toBeLessThanOrEqual(280);
  });

  it("checks a same-computer move's named account against the project's and this computer's pools", async () => {
    const { localPoolRefusal } = await import("./move-computers.js");
    const { setAccountSettings } = await import("./account-pools.js");
    vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
    const checkout = path.join(home, "checkout");
    mkdirSync(path.join(checkout, "src"), { recursive: true });
    writeFileSync(path.join(store, "client-a/phren.project.yaml"), `sourcePath: ${checkout}\nallowedPools: [client-a]\n`);
    clearProjectConfigCache();
    await setAccountSettings("big", { pool: "personal" });
    await setAccountSettings("small", { pool: "client-a" });
    expect(await localPoolRefusal(path.join(checkout, "src"), "big")).toMatch(/its pool personal is not in project client-a's allowed pools/);
    expect(await localPoolRefusal(path.join(checkout, "src"), "small")).toBeUndefined();
    // Outside any project only this computer's own list applies, and it has none.
    expect(await localPoolRefusal(home, "big")).toBeUndefined();
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
    await expect(checkMovePeer(peer(allOut), "client-a", { harness: "claude" } as never)).rejects.toThrow(/No Claude account on Desk may continue this: default: not allowed; api: not allowed/);
    // A peer on an older Hook reports no pools: this side still checks the project's list.
    const older = { ...facts, harnesses: facts.harnesses.map(row => row.source === "claude" ? { ...row, accounts: row.accounts!.map(({ pool: _pool, role: _role, poolRefused: _refused, ...login }) => login) } : row) };
    await expect(checkMovePeer(peer(older), "client-a", { harness: "claude", account: "api" } as never)).rejects.toThrow(/api on Desk may not do this work: it has no pool/);
  });
});
