import { afterEach, describe, expect, it, vi } from "vitest";
import { accountTitles, creditsValue, sortUsageAccounts, metaLine, mountUsageRings, openUsage, subscriptionSummary, windowText } from "../ui/shell/usage-rings.js";

const now = Date.parse("2026-10-11T12:00:00.000Z");
const later = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

describe("usage popover text", () => {
  it("names each card by email, adds the plan when one email has two plans, and numbers unnamed accounts", () => {
    const titles = accountTitles([
      { id: "claude|a", harness: "claude", name: "Claude", account: "sam@example.com", subscription: { plan: "Max 20x" } },
      { id: "claude|b", harness: "claude", name: "Claude", account: "sam@example.com", subscription: { plan: "Team" } },
      { id: "claude|c", harness: "claude", name: "Claude", account: "kit@example.com", subscription: { plan: "Pro" } },
      { id: "codex", harness: "codex", name: "Codex" },
      { id: "copilot|x", harness: "copilot", name: "GitHub Copilot" },
      { id: "copilot|y", harness: "copilot", name: "GitHub Copilot" },
    ]);
    expect([...titles.values()]).toEqual(["Claude · sam@example.com · Max 20x", "Claude · sam@example.com · Team", "Claude · kit@example.com",
      "Codex", "GitHub Copilot · Account 1", "GitHub Copilot · Account 2"]);
  });

  it("writes the plan line and one meta line like the phone", () => {
    expect(subscriptionSummary({ plan: "Max 20x", startedAt: "2026-07-13T00:00:00Z", renewsAt: "2026-10-13T00:00:00Z", renewsEstimated: true }, now))
      .toBe("Max 20x · since Jul 13 · renews about Oct 13");
    expect(subscriptionSummary({ plan: "Plus", startedAt: "2026-07-13T00:00:00Z", renewsAt: "2026-10-06T00:00:00Z" }, now))
      .toBe("Plus · since Jul 13");
    expect(subscriptionSummary(undefined)).toBe("");
    expect(metaLine({ computers: [{ name: "Mini" }, { name: "Mini", account: "work" }, { name: "Workstation" }], updatedAt: new Date(now - 60_000).toISOString() }, now))
      .toBe("Mini, Workstation · updated 1m ago");
  });

  it("gives every window its reset, a 5-hour window without one 'not started', and an API credit its dollars and expiry", () => {
    expect(windowText({ id: "seven_day", name: "7-day", usedPercent: 40, resetsAt: later(50) }, now)).toMatchObject({ value: "40%", caption: "resets in 2d 2h" });
    expect(windowText({ id: "five_hour", name: "5-hour limit", usedPercent: 0 }, now)).toMatchObject({ value: "0%", caption: "not started" });
    expect(windowText({ id: "five_hour", name: "5-hour limit", reset: true }, now)).toMatchObject({ value: "reset", caption: "" });
    const credit = windowText({ id: "credit:abcd1234", name: "Promo, estimate", usedPercent: 31, usedUSD: 31, limitUSD: 100, resetsAt: "2026-12-31T12:00:00.000Z" }, now);
    expect(credit.value).toBe("$31.00 of $100.00");
    expect(credit.caption).toMatch(/^expires Dec 31$/);
    expect(windowText({ id: "codex:primary", name: "5-hour limit", usedPercent: 100, limited: true, resetsAt: later(1) }, now).caption).toBe("Limit reached · resets in 1h 0m");
  });

  it("shows Codex credits only when the account has them", () => {
    expect(creditsValue({ hasCredits: true, balance: 1250.5, inUse: true })).toBe("1,250.5");
    expect(creditsValue({ hasCredits: true, unlimited: true })).toBe("Unlimited");
    expect(creditsValue({ hasCredits: false, balance: 0 })).toBe("");
    expect(creditsValue(undefined)).toBe("");
  });
});

describe("usage account ordering", () => {
  it("puts exhausted accounts first, then the tightest active window, unknown last, without changing reports", () => {
    const rows = [
      { id: "unknown" },
      { id: "roomy", windows: [{ usedPercent: 20 }, { usedPercent: 100, reset: true }] },
      { id: "weekly", windows: [{ usedPercent: 10 }, { usedPercent: 95 }] },
      { id: "exhausted", exhausted: true },
      { id: "limited", windows: [{ usedPercent: 100, limited: true }] },
      { id: "remaining", windows: [{ leftPercent: 8 }] },
      { id: "tie", windows: [{ usedPercent: 95 }] },
    ];
    expect(sortUsageAccounts(rows).map(r => r.id)).toEqual(["limited", "exhausted", "weekly", "tie", "remaining", "roomy", "unknown"]);
    expect(rows[0].id).toBe("unknown");
    expect(sortUsageAccounts(undefined)).toEqual([]);
  });

  it("labels exhaustion even without the limited flag and identifies unknown resets", () => {
    expect(windowText({ usedPercent: 100, exhausted: true }, now)).toMatchObject({ value: "100%", caption: "Exhausted · reset time unknown" });
  });
});

// Minimal DOM for the popover lifecycle, with real rendering and event handlers.
class UsageNode {
  children: UsageNode[] = [];
  hidden = false;
  isConnected = true;
  style = { left: "", top: "", setProperty: vi.fn() };
  bounds = { left: 0, right: 320, bottom: 29, width: 320 };
  getBoundingClientRect() { return this.bounds; }
  textContent = "";
  className = "";
  classList = { add() {}, remove() {}, toggle() {} };
  listeners = new Map<string, (ev: unknown) => void>();
  append(...nodes: UsageNode[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: UsageNode[]) { this.children = nodes; }
  setAttribute() {}
  addEventListener(event: string, fn: (ev: unknown) => void) { this.listeners.set(event, fn); }
  focus = vi.fn(() => { Object.assign(document, { activeElement: this }); });
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function usagePopover(snapshot = { accounts: [] as object[], computers: [] as string[] }) {
  vi.useFakeTimers();
  const events = new Map<string, (ev: unknown) => void>();
  const origin = new UsageNode();
  const viewport = { innerWidth: 1280, innerHeight: 800, addEventListener: (event: string, fn: (ev: unknown) => void) => events.set(event, fn), removeEventListener: (event: string) => events.delete(event) };
  vi.stubGlobal("window", viewport);
  vi.stubGlobal("document", {
    querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 40 }) }),
    activeElement: origin,
    createElement: () => new UsageNode(), createElementNS: () => new UsageNode(),
    addEventListener: (event: string, fn: (ev: unknown) => void) => events.set(event, fn),
    removeEventListener: (event: string) => events.delete(event),
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => snapshot })));
  const host = new UsageNode();
  const handle = mountUsageRings(host);
  openUsage();
  const popover = host.children[1];
  await vi.advanceTimersByTimeAsync(0);
  return { popover, origin, events, handle, host, viewport };
}

it("opens without rings and returns focus on Escape after rendering the latest shared usage", async () => {
  const { popover, origin, events, handle } = await usagePopover();
  expect(popover.hidden).toBe(false);
  expect(popover.focus).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(0);
  expect(popover.children[0].textContent).toBe("0 accounts across 0 computers.");
  events.get("keydown")!({ key: "Escape", preventDefault() {}, stopImmediatePropagation() {} });
  expect(popover.hidden).toBe(true);
  expect(origin.focus).toHaveBeenCalledOnce();
  expect(events.size).toBe(0);
  handle.close();
});

it("renders every account window most constrained first without changing report order", async () => {
  const windows = [
    { name: "Roomy", usedPercent: 10 },
    { name: "Weekly", usedPercent: 95 },
    { name: "Exhausted", exhausted: true, usedPercent: 30 },
    { name: "Limited", limited: true, usedPercent: 100 },
    { name: "Unknown" },
    { name: "Reset", reset: true, usedPercent: 100 },
    { name: "Remaining", leftPercent: 8 },
    { name: "Tie", usedPercent: 95 },
  ];
  const { popover, handle } = await usagePopover({ accounts: [{ id: "a", name: "Claude", harness: "claude", windows }], computers: ["Mini"] });
  const card = popover.children.find(node => node.className === "usage-account")!;
  const list = card.children.find(node => node.className === "usage-windows")!;
  expect(list.children.map(node => node.children[0].textContent)).toEqual(["Limited", "Exhausted", "Weekly", "Tie", "Remaining", "Roomy", "Unknown", "Reset"]);
  expect(windows.map(w => w.name)).toEqual(["Roomy", "Weekly", "Exhausted", "Limited", "Unknown", "Reset", "Remaining", "Tie"]);
  handle.close();
});

it("centers keyboard usage under the titlebar and repositions on resize", async () => {
  const { popover, viewport, events, handle } = await usagePopover();
  expect(popover.style.left).toBe("480px");
  expect(popover.style.top).toBe("50px");
  for (const width of [420, 320, 240]) {
    viewport.innerWidth = width;
    popover.bounds.width = width - 32;
    events.get("resize")!({});
    expect(popover.style.left).toBe("16px");
  }
  handle.close();
  expect(events.has("resize")).toBe(false);
});

it("keeps the wide ring anchor and clamps either edge on narrow windows", async () => {
  const { popover, viewport, events, handle, host } = await usagePopover({ accounts: [{ id: "a", name: "Claude", harness: "claude", windows: [] }], computers: ["Mini"] });
  const dismiss = () => events.get("keydown")!({ key: "Escape", preventDefault() {}, stopImmediatePropagation() {} });
  dismiss();
  host.bounds = { left: 1160, right: 1200, width: 40, bottom: 29 };
  host.children[0].children[0].listeners.get("click")!({ stopPropagation() {} });
  expect(popover.style.left).toBe("880px");
  expect(popover.style.top).toBe("39px");
  viewport.innerWidth = 420;
  popover.bounds.width = 388;
  for (const right of [292, 800]) {
    host.bounds.right = right;
    events.get("resize")!({});
    expect(popover.style.left).toBe("16px");
  }
  handle.close();
});
