import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAccountCaches } from "./claude-accounts.js";
import { harnessInventory, harnessInventoryWithin, hasUsable } from "./harnesses.js";
import type { ToolVersion } from "./health.js";

let home = "";
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "phren-harnesses-"));
  vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("CODEX_HOME", path.join(home, ".codex"));
  vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
  clearAccountCaches();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

const versions: Record<string, ToolVersion> = {
  claude: { tool: "claude", status: "ok", version: "2.1.284" },
  codex: { tool: "codex", status: "ok", version: "0.155.0" },
  opencode: { tool: "opencode", status: "missing" },
  copilot: { tool: "copilot", status: "error", detail: "--version did not answer within 3 seconds" },
  phren: { tool: "phren agent", status: "ok", version: "0.3.18" },
};
const probe = async (tool: string) => versions[tool];
const auth = async (h: { id: string }) => JSON.stringify({ loggedIn: h.id === "default", subscriptionType: "max" });

it("reports install state, Claude accounts and Codex sign-in", async () => {
  mkdirSync(path.join(home, ".claude-work")); writeFileSync(path.join(home, ".claude-work/.claude.json"), "{}");
  mkdirSync(path.join(home, ".codex")); writeFileSync(path.join(home, ".codex/auth.json"), "{}");
  const { harnesses } = await harnessInventory({ toolVersion: probe, authRunner: auth });
  const by = Object.fromEntries(harnesses.map(h => [h.source, h]));
  expect(by.claude).toMatchObject({ installed: true, version: "2.1.284", usable: true });
  expect(by.claude.accounts).toMatchObject([
    { id: "default", label: "Claude", signedIn: true, usable: true, plan: "max" },
    { id: "work", label: "Work", signedIn: false, usable: false, reason: "Not signed in", key: "claude:home:work" },
  ]);
  expect(by.codex).toMatchObject({ usable: true, accounts: [{ id: "default", label: "Codex", key: "codex", signedIn: true, usable: true }] });
  expect(by.opencode).toEqual({ source: "opencode", installed: false, usable: false, reason: "Not installed" });
  // A slow --version is not "missing": the harness stays offered.
  expect(by.copilot).toMatchObject({ installed: true, usable: true });
  expect(by.copilot.version).toBeUndefined();
});

it("marks Codex unusable without auth.json and Claude unusable with no signed-in account", async () => {
  const { harnesses } = await harnessInventory({ toolVersion: probe, authRunner: async () => '{"loggedIn":false}' });
  expect(harnesses[0]).toMatchObject({ source: "claude", usable: false, reason: "No signed-in Claude account" });
  expect(harnesses[1]).toMatchObject({ source: "codex", usable: false, accounts: [{ signedIn: false, usable: false }] });
});

it("hasUsable answers for dispatch", async () => {
  mkdirSync(path.join(home, ".claude-work")); writeFileSync(path.join(home, ".claude-work/.claude.json"), "{}");
  const inv = await harnessInventory({ toolVersion: async t => t === "copilot" ? versions.claude : versions[t], authRunner: auth });
  expect(hasUsable(inv, "claude")).toEqual({ ok: true });
  expect(hasUsable(inv, "claude", "work")).toMatchObject({ ok: false, code: "account_unavailable", reason: "Not signed in" });
  expect(hasUsable(inv, "claude", "ghost")).toMatchObject({ ok: false, code: "account_unavailable" });
  expect(hasUsable(inv, "opencode")).toMatchObject({ ok: false, code: "harness_unavailable", reason: "Not installed" });
  expect(hasUsable(inv, "copilot")).toEqual({ ok: true });
  expect(hasUsable(inv, "copilot", "work")).toMatchObject({ ok: false, code: "account_unavailable" });
  expect(hasUsable(inv, "nothing")).toMatchObject({ ok: false, code: "harness_unavailable" });
});

it("keeps an account usable when Claude does not answer its sign-in check", async () => {
  const inv = await harnessInventory({ toolVersion: async t => versions[t], authRunner: async () => "" });
  const claude = inv.harnesses.find(h => h.source === "claude")!;
  expect(claude.accounts![0]).toMatchObject({ id: "default", signedIn: false, usable: true });
  expect(hasUsable(inv, "claude")).toEqual({ ok: true });
});

it("answers within its bound while a cold sign-in check is still running", async () => {
  let release!: (value: string) => void;
  const slow = new Promise<string>(resolve => { release = resolve; });
  const started = Date.now();
  expect(await harnessInventoryWithin(50, { toolVersion: async t => versions[t], authRunner: () => slow })).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(1_000);
  release('{"loggedIn":true}');
  // The probe kept running and cached its answer for the next request.
  const inv = await harnessInventoryWithin(1_000, { toolVersion: async t => versions[t], authRunner: () => slow });
  expect(inv?.harnesses.find(h => h.source === "claude")?.accounts?.[0]).toMatchObject({ signedIn: true, usable: true });
});

it("offers phren's own agent when `phren agent --version` answers, with no accounts and no sign-in check", async () => {
  const asked: string[] = [];
  const { harnesses } = await harnessInventory({ toolVersion: async t => { asked.push(t); return versions[t]; }, authRunner: auth });
  expect(asked).toContain("phren");
  const phren = harnesses.find(h => h.source === "phren");
  expect(phren).toEqual({ source: "phren", installed: true, version: "0.3.18", usable: true });
  expect(hasUsable({ harnesses }, "phren")).toEqual({ ok: true });
  expect(hasUsable({ harnesses }, "phren", "work")).toMatchObject({ ok: false, code: "account_unavailable" });
});

it("marks phren's agent missing without phren, or when phren answers without @phren/agent", async () => {
  for (const found of [{ tool: "phren agent", status: "missing" }, { tool: "phren agent", status: "error", detail: "--version exited 1 without a version" }] as ToolVersion[]) {
    const { harnesses } = await harnessInventory({ toolVersion: async t => t === "phren" ? found : versions[t], authRunner: auth });
    const phren = harnesses.find(h => h.source === "phren")!;
    expect(phren).toMatchObject({ installed: false, usable: false });
    expect(hasUsable({ harnesses }, "phren")).toMatchObject({ ok: false, code: "harness_unavailable" });
  }
  // A --version too slow to answer is not a missing agent.
  const slow = await harnessInventory({ toolVersion: async t => t === "phren" ? { tool: t, status: "error", detail: "--version did not answer within 3 seconds" } : versions[t], authRunner: auth });
  expect(slow.harnesses.find(h => h.source === "phren")).toMatchObject({ installed: true, usable: true });
});
