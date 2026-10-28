import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { clearProjectConfigCache, readProjectConfig } from "../project-config.js";
import { accountPoolsCommand, accountSettings, computerAllowedPools, projectAllowedPools, setAccountSettings, setComputerAllowedPools, setProjectAllowedPools } from "./account-pools.js";
import { clearAccountCaches, setAccountLabel } from "./claude-accounts.js";
import { addClaudeCredit } from "./claude-credits.js";
import { harnessInventory } from "./harnesses.js";
import type { Json } from "./protocol.js";
import { capabilitiesForModules, createRouteHandler } from "./server-routes.js";

let home = "", store = "";
const yaml = () => load(readFileSync(path.join(home, "bridge/accounts.yaml"), "utf8")) as Record<string, unknown>;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "phren-pools-"));
  store = path.join(home, "store");
  vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
  clearAccountCaches(); clearProjectConfigCache();
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  for (const slug of ["api200", "team"]) {
    mkdirSync(path.join(home, `.claude-${slug}`), { recursive: true });
    writeFileSync(path.join(home, `.claude-${slug}`, ".claude.json"), "{}");
  }
  mkdirSync(path.join(store, "qualus"), { recursive: true });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe("account pools and roles", () => {
  it("sets, changes and clears a slot's pool and role, keeping labels, credits and other slots", async () => {
    await setAccountLabel("api200", "API $200");
    await addClaudeCredit("api200", { amount: "200" });
    expect(await setAccountSettings("api200", { pool: "personal", role: "helpers" })).toEqual({ pool: "personal", role: "helpers" });
    expect(await setAccountSettings("team", { role: "off" })).toEqual({ role: "off" });
    // A field left out stays.
    expect(await setAccountSettings("api200", { pool: "qualus" })).toEqual({ pool: "qualus", role: "helpers" });
    expect(accountSettings()).toEqual({ api200: { pool: "qualus", role: "helpers" }, team: { role: "off" } });
    expect(yaml()).toMatchObject({ claude: { api200: "API $200" }, credits: { api200: [expect.objectContaining({ amountUSD: 200 })] } });
    expect(await setAccountSettings("api200", { pool: null, role: null })).toEqual({});
    await setAccountSettings("team", { role: null });
    expect(accountSettings()).toEqual({});
    expect(yaml()).not.toHaveProperty("slots");
  });

  it("refuses bad pools, roles and names, and never overwrites a file it can't read", async () => {
    await expect(setAccountSettings("api200", { pool: "Client A" })).rejects.toThrow(/lowercase/);
    await expect(setAccountSettings("api200", { role: "sometimes" as never })).rejects.toThrow(/helpers, last-resort, off/);
    await expect(setAccountSettings("../x", { pool: "a" })).rejects.toThrow(/account name/);
    mkdirSync(path.join(home, "bridge"), { recursive: true });
    writeFileSync(path.join(home, "bridge/accounts.yaml"), "- not\n- a mapping\n");
    await expect(setAccountSettings("api200", { pool: "a" })).rejects.toThrow(/not a mapping/);
    expect(readFileSync(path.join(home, "bridge/accounts.yaml"), "utf8")).toBe("- not\n- a mapping\n");
  });

  it("loses no change when labels, credits and pools are written at once", async () => {
    await Promise.all([
      setAccountLabel("api200", "API $200"),
      addClaudeCredit("api200", { amount: "200" }),
      setAccountSettings("api200", { pool: "personal" }),
      setAccountSettings("team", { role: "off" }),
      setComputerAllowedPools(["personal"]),
      setAccountLabel("team", "Team"),
    ]);
    expect(yaml()).toMatchObject({ claude: { api200: "API $200", team: "Team" }, credits: { api200: [expect.objectContaining({ amountUSD: 200 })] },
      slots: { api200: { pool: "personal" }, team: { role: "off" } }, allowedPools: ["personal"] });
  });

  it("never lets a label or credit write replace a file it can't read, and reads nothing from one", async () => {
    await setAccountSettings("api200", { pool: "personal" });
    expect(yaml()).toHaveProperty("slots");
    writeFileSync(path.join(home, "bridge/accounts.yaml"), "claude: [unclosed\n");
    await expect(setAccountLabel("api200", "x")).rejects.toThrow();
    await expect(addClaudeCredit("api200", { amount: "5" })).rejects.toThrow();
    expect(readFileSync(path.join(home, "bridge/accounts.yaml"), "utf8")).toBe("claude: [unclosed\n");
    expect(accountSettings()).toEqual({});
    expect(computerAllowedPools()).toBeUndefined();
    // A write after a refused one still runs.
    rmSync(path.join(home, "bridge/accounts.yaml"));
    await setAccountLabel("api200", "ok");
    expect(yaml()).toEqual({ claude: { api200: "ok" } });
  });

  it("keeps a project's config it can't parse", () => {
    writeFileSync(path.join(store, "qualus/phren.project.yaml"), "sourcePath: [unclosed\n");
    expect(() => setProjectAllowedPools(store, "qualus", ["qualus"])).toThrow(/can't be read/);
    writeFileSync(path.join(store, "qualus/phren.project.yaml"), "- a list\n");
    expect(() => setProjectAllowedPools(store, "qualus", ["qualus"])).toThrow(/not a mapping/);
    expect(readFileSync(path.join(store, "qualus/phren.project.yaml"), "utf8")).toBe("- a list\n");
  });

  it("keeps this computer's and a project's allowed pools, none meaning any", async () => {
    expect(computerAllowedPools()).toBeUndefined();
    expect(await setComputerAllowedPools(["personal", "qualus", "personal"])).toEqual(["personal", "qualus"]);
    expect(computerAllowedPools()).toEqual(["personal", "qualus"]);
    await expect(setComputerAllowedPools([])).rejects.toThrow(/at least one/);
    await expect(setComputerAllowedPools(["Nope"])).rejects.toThrow(/lowercase/);
    expect(await setComputerAllowedPools(null)).toBeUndefined();
    expect(computerAllowedPools()).toBeUndefined();

    writeFileSync(path.join(store, "qualus/phren.project.yaml"), "sourcePath: /work/qualus\n");
    expect(projectAllowedPools(store, "qualus")).toBeUndefined();
    expect(setProjectAllowedPools(store, "qualus", ["qualus"])).toEqual(["qualus"]);
    expect(projectAllowedPools(store, "qualus")).toEqual(["qualus"]);
    expect(readProjectConfig(store, "qualus").sourcePath).toBe("/work/qualus");
    setProjectAllowedPools(store, "qualus", null);
    expect(readFileSync(path.join(store, "qualus/phren.project.yaml"), "utf8")).not.toContain("allowedPools");
  });

  it("reads and sets them from the command line", async () => {
    const run = (...args: string[]) => accountPoolsCommand(args, () => store, slug => ["default", "api200", "team"].includes(slug));
    expect(await run("pool", "api200", "personal")).toEqual(["api200: pool personal, role none."]);
    expect(await run("role", "api200", "helpers")).toEqual(["api200: pool personal, role helpers."]);
    expect(await run("role", "api200", "--clear")).toEqual(["api200: pool personal, role none."]);
    await expect(run("role", "api200", "maybe")).rejects.toThrow(/role is/);
    await expect(run("pool", "ghost", "personal")).rejects.toThrow(/no Claude account "ghost"/);
    expect(await run("allowed-pools")).toEqual(["This computer: any pool."]);
    expect(await run("allowed-pools", "personal", "qualus")).toEqual(["This computer: allowed pools personal, qualus."]);
    expect(await run("allowed-pools", "--project", "qualus", "qualus")).toEqual(["Project qualus: allowed pools qualus."]);
    expect(await run("allowed-pools", "--project", "qualus")).toEqual(["Project qualus: allowed pools qualus."]);
    expect(await run("allowed-pools", "--project", "qualus", "--clear")).toEqual(["Project qualus: any pool."]);
    await expect(run("allowed-pools", "--project", "nowhere", "x")).rejects.toThrow(/no project "nowhere"/);
    await expect(run("allowed-pools", "--project", "../etc", "x")).rejects.toThrow(/no project/);
    await expect(run("pools")).rejects.toThrow(/Usage/);
  });

  it("lists each account's pool and role, and this computer's allowed pools, in the harness inventory", async () => {
    await setAccountSettings("api200", { pool: "personal", role: "helpers" });
    await setComputerAllowedPools(["personal"]);
    const inventory = await harnessInventory({ toolVersion: async () => ({ status: "ok", version: "1.0" }) as never,
      authRunner: async () => JSON.stringify({ loggedIn: true }) });
    const claude = inventory.harnesses.find(entry => entry.source === "claude")!;
    expect(claude.accounts!.find(account => account.id === "api200")).toMatchObject({ pool: "personal", role: "helpers" });
    expect(claude.accounts!.find(account => account.id === "team")).not.toHaveProperty("pool");
    expect(inventory.allowedPools).toEqual(["personal"]);
  });

  it("leaves the harness inventory as it was when nothing is set", async () => {
    const inventory = await harnessInventory({ toolVersion: async () => ({ status: "ok", version: "1.0" }) as never,
      authRunner: async () => JSON.stringify({ loggedIn: true }) });
    expect(inventory).not.toHaveProperty("allowedPools");
    for (const account of inventory.harnesses.find(entry => entry.source === "claude")!.accounts!) {
      expect(account).not.toHaveProperty("pool");
      expect(account).not.toHaveProperty("role");
    }
  });
});

describe("account pool routes", () => {
  const modules = { has: () => true, modules: BUILTIN_MODULES };
  async function post(url: string, body: Json, headers: Record<string, string> = {}) {
    const handler = createRouteHandler({ modules, info: { computer: { id: "00000000-0000-4000-8000-0000000000aa", name: "self" }, capabilities: capabilitiesForModules(modules as never) },
      accountUsage: { read: async () => ({ accounts: [] }) }, streams: {} } as never);
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
    req.method = "POST"; req.url = url; req.headers = headers;
    let payload = "";
    const res = { statusCode: 200, setHeader() {}, end(value: string) { payload = value; } };
    await handler(req, res as unknown as ServerResponse);
    return { status: res.statusCode, body: JSON.parse(payload) as Json };
  }

  it("sets an account's pool and role for the owner only", async () => {
    expect(capabilitiesForModules(modules as never).accountPools).toBe(true);
    expect(await post("/v1/accounts/claude/settings", { slug: "api200", pool: "personal", role: "helpers" }))
      .toEqual({ status: 200, body: { ok: true, slug: "api200", pool: "personal", role: "helpers" } });
    expect(await post("/v1/accounts/claude/settings", { slug: "api200", role: null })).toEqual({ status: 200, body: { ok: true, slug: "api200", pool: "personal" } });
    expect((await post("/v1/accounts/claude/settings", { slug: "api200", role: "always" })).status).toBe(400);
    expect((await post("/v1/accounts/claude/settings", { slug: "api200", pool: "Bad Pool" })).status).toBe(400);
    expect((await post("/v1/accounts/claude/settings", { slug: "ghost", pool: "personal" })).status).toBe(404);
    expect((await post("/v1/accounts/claude/settings", { slug: "api200", pool: "x" }, { "x-phren-origin": "peer" })).status).toBe(403);
    expect((await post("/v1/accounts/claude/settings", { slug: "api200", pool: "x", origin: "peer" })).status).toBe(403);
    expect(accountSettings()).toEqual({ api200: { pool: "personal" } });
  });

  it("sets this computer's allowed pools for the owner only", async () => {
    expect(await post("/v1/accounts/allowed-pools", { allowedPools: ["personal"] })).toEqual({ status: 200, body: { ok: true, allowedPools: ["personal"] } });
    expect((await post("/v1/accounts/allowed-pools", { allowedPools: [] })).status).toBe(400);
    expect((await post("/v1/accounts/allowed-pools", { allowedPools: null }, { "x-phren-origin": "peer" })).status).toBe(403);
    expect(await post("/v1/accounts/allowed-pools", { allowedPools: null })).toEqual({ status: 200, body: { ok: true } });
    expect(computerAllowedPools()).toBeUndefined();
  });
});
