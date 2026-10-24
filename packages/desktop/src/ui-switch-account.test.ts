import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain ESM UI module
import { loginCommand, switchAccountRows, switchStatus } from "../ui/shell/switch-account.js";

vi.mock("../ui/api.js", () => ({ hookGet: vi.fn(), hookPost: vi.fn() }));
vi.mock("../ui/shell/store.js", () => ({ projectOf: () => "", store: { capabilities: async () => ({}), sessions: () => [] } }));
vi.mock("../ui/shell/sections.js", async (original) => ({ ...await original<object>(), showSection: vi.fn(), sectionHandle: () => null }));

const NOW = Date.parse("2026-10-17T18:00:00Z");
const inventory = [{ source: "claude", installed: true, usable: true, accounts: [
  { id: "default", label: "Team", signedIn: true, usable: true },
  { id: "gmail", label: "gmail Max", signedIn: true, usable: true },
  { id: "max", label: "ala Max", signedIn: true, usable: true },
  { id: "support", label: "support", signedIn: false, usable: false, reason: "Not signed in" },
] }];
const usage = (account: string, used: number, resetsAt = "2026-10-17T21:30:00Z") => ({ id: `claude:${account}`, harness: "claude",
  computers: [{ name: "Desk", account }], windows: [{ id: "five_hour", usedPercent: used, resetsAt }] });
const session = (account?: string) => ({ computer: "Desk", child: { target: { source: "claude" }, ...(account ? { account: { id: account } } : {}) } });

describe("switch account rows", () => {
  it("puts the chat's own account first, then pickable accounts by room, then the ones that can't take it", () => {
    const rows = switchAccountRows(session(), inventory, [usage("default", 100), usage("gmail", 40), usage("max", 10)], NOW);
    expect(rows.map((r: { id: string }) => r.id)).toEqual(["default", "max", "gmail", "support"]);
    expect(rows[0]).toMatchObject({ current: true, reason: "This chat's account", exhausted: true });
    expect(rows[1]).toMatchObject({ reason: "", left: 90, detail: "90% left of 5-hour" });
    expect(rows[2]).toMatchObject({ reason: "", left: 60 });
  });

  it("disables an exhausted account and says when it resets", () => {
    const rows = switchAccountRows(session("gmail"), inventory, [usage("max", 100)], NOW);
    const max = rows.find((r: { id: string }) => r.id === "max");
    expect(max.reason).toBe("Out of usage");
    expect(max.detail).toMatch(/^Out of usage · resets /);
    // An account with no usage report can still be picked.
    expect(rows.find((r: { id: string }) => r.id === "default")).toMatchObject({ reason: "", detail: "Usage unknown" });
  });

  it("offers the /login step for a slot that is not signed in", () => {
    const support = switchAccountRows(session(), inventory, [], NOW).find((r: { id: string }) => r.id === "support");
    expect(support).toMatchObject({ reason: "Not signed in", login: "CLAUDE_CONFIG_DIR=~/.claude-support claude /login" });
    expect(loginCommand("default")).toBe("claude /login");
  });

  it("keeps an account selectable when its sign-in check could not finish", () => {
    const unsure = [{ source: "claude", accounts: [{ id: "default", signedIn: true, usable: true }, { id: "slow", label: "Slow", signedIn: false, usable: true, reason: "Could not check sign-in" }] }];
    const slow = switchAccountRows(session(), unsure, [], NOW).find((r: { id: string }) => r.id === "slow");
    expect(slow).toMatchObject({ reason: "", login: "", detail: "Usage unknown · Sign-in not checked" });
  });

  it("matches usage to the account on this computer only", () => {
    const other = { ...usage("max", 100), computers: [{ name: "Laptop", account: "max" }] };
    expect(switchAccountRows(session(), inventory, [other], NOW).find((r: { id: string }) => r.id === "max")).toMatchObject({ reason: "", detail: "Usage unknown" });
  });

  it("words the move states of a switch", () => {
    expect(switchStatus({ state: "exiting" })).toBe("Ending the current agent…");
    expect(switchStatus({ state: "launching" })).toBe("Resuming under the new account…");
    expect(switchStatus({ state: "failed", error: "disk full" })).toBe("The switch failed: disk full");
  });
});
