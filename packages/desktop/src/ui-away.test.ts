import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_AWAY_MS, away as sharedAway, createAway, startAway } from "../ui/shell/away.js";

const feeds = vi.hoisted(() => ({ usage: null as null | ((snapshot: unknown) => void), section: null as null | ((id: string) => void) }));
vi.mock("../ui/shell/usage-rings.js", async (original) => ({
  ...await original<object>(),
  followUsage: (fn: (snapshot: unknown) => void) => { feeds.usage = fn; return () => { feeds.usage = null; }; },
}));
vi.mock("../ui/shell/sections.js", () => ({ onSectionChange: (fn: (id: string) => void) => { feeds.section = fn; return () => { feeds.section = null; }; } }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const target = (session: string, source = "claude") => ({ server: "tmux", workspace: "work", tab: "one", pane: session, source, session });
const usage = (usedPercent: number, extra = {}) => ({ accounts: [{
  id: "claude|work", harness: "claude", name: "Claude", account: "Work", computers: [{ name: "mini", account: "work" }],
  windows: [{ id: "five_hour", usedPercent }], ...extra,
}] });
const row = (id: string, agentStatus: string) => ({ key: `mini/${id}`, computer: "mini", child: { id, title: `Task ${id}`, agentStatus } });

function clock() {
  let t = 1_000_000;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

describe("away", () => {
  it("lists the turns that ended while away, newest first, once back", () => {
    const c = clock();
    const away = createAway({ now: c.now });
    away.observe([row("a", "working"), row("b", "working"), row("c", "idle")]);
    away.leave();
    c.tick(30_000);
    away.observe([row("a", "idle"), row("b", "working"), row("c", "idle")]);
    c.tick(60_000);
    away.observe([row("a", "idle"), row("b", "waiting"), row("c", "working")]);
    away.back();
    expect(away.current()?.rows.map((r) => r.key)).toEqual(["mini/b", "mini/a"]);
    away.dismiss();
    expect(away.current()).toBeNull();
  });

  it("ignores a short absence and turns that ended while you were here", () => {
    const c = clock();
    const away = createAway({ now: c.now });
    away.observe([row("a", "working")]);
    away.observe([row("a", "idle")]); // here: not counted
    away.observe([row("a", "working")]);
    away.leave();
    away.observe([row("a", "idle")]);
    c.tick(MIN_AWAY_MS - 1);
    away.back();
    expect(away.current()).toBeNull();
  });

  it("adds pull requests whose checks settled while away, latest result per request", () => {
    const c = clock();
    const away = createAway({ now: c.now });
    const pull = (checks: string) => ({ computer: "mini", project: "phren", number: 42, title: "Guard", ref: "#", checks, child: { id: "a" } });
    away.noteChecks(pull("failing")); // here: not counted
    away.leave();
    away.noteChecks(pull("failing"));
    away.noteChecks(pull("passing"));
    c.tick(MIN_AWAY_MS);
    away.back();
    expect(away.current()?.rows).toEqual([]);
    expect(away.current()?.checks.map((p) => p.checks)).toEqual(["passing"]);
  });
});


describe("away handoffs and account room", () => {
  it.each(["to", "from", "both"])("collects new %s references once, links the new chat and does not replay dismissed handoffs", (direction) => {
    const c = clock();
    const away = createAway({ now: c.now });
    const old = { ...row("a", "idle"), child: { ...row("a", "idle").child, title: "Fix login", target: target("a") } };
    const next = { ...row("b", "idle"), child: { ...row("b", "idle").child, agent: "codex", target: target("b", "codex") } };
    away.observe([old]);
    away.leave();
    c.tick(MIN_AWAY_MS);
    const rows = [
      { ...old, child: { ...old.child, ...(direction !== "from" ? { handedOffTo: { target: next.child.target } } : {}) } },
      { ...next, child: { ...next.child, ...(direction !== "to" ? { handedOffFrom: { target: old.child.target } } : {}) } },
    ];
    away.observe(rows);
    away.back();
    expect(away.current()?.events).toMatchObject([{ kind: "handoff", computer: "mini", title: "Fix login moved to Codex", target: next.child.target }]);
    away.dismiss();
    away.leave();
    away.observe([]); // a reconnect must not reintroduce old references
    away.observe(rows);
    c.tick(MIN_AWAY_MS);
    away.back();
    expect(away.current()).toBeNull();
  });

  it("silently baselines existing handoffs and ignores references seen while Home is attended", () => {
    const c = clock();
    const away = createAway({ now: c.now });
    const moved = (id: string) => ({ ...row(id, "idle"), child: { target: target(id), handedOffTo: target(`${id}-new`, "codex") } });
    away.leave();
    away.observe([moved("a")]);
    c.tick(MIN_AWAY_MS);
    away.back();
    expect(away.current()).toBeNull();
    away.observe([moved("a"), moved("b")]);
    away.leave();
    away.observe([moved("a"), moved("b")]);
    c.tick(MIN_AWAY_MS);
    away.back();
    expect(away.current()).toBeNull();
  });

  it("collects account recoveries through stale polls, newest first, without replay after dismissal", () => {
    const c = clock();
    const away = createAway({ now: c.now });
    away.observeUsage(usage(100));
    away.leave();
    away.observeUsage(usage(0, { stale: true }));
    c.tick(MIN_AWAY_MS);
    away.observeUsage(usage(20));
    away.back();
    expect(away.current()?.events).toMatchObject([{ kind: "quota", computer: "mini", title: "Claude · Work is available again (5-hour limit reset)" }]);
    away.dismiss();
    away.leave();
    away.observeUsage(usage(20));
    c.tick(MIN_AWAY_MS);
    away.back();
    expect(away.current()).toBeNull();
    // A recovery observed here must also be consumed, even after the cooldown.
    c.tick(600_000);
    away.observeUsage(usage(100));
    away.observeUsage(usage(0));
    away.leave();
    away.observeUsage(usage(0));
    c.tick(MIN_AWAY_MS);
    away.back();
    expect(away.current()).toBeNull();
  });

  it("bounds away events to the newest twenty and orders handoffs with quota recoveries", () => {
    const c = clock();
    const away = createAway({ now: c.now });
    away.observe([]);
    away.observeUsage(usage(100));
    away.leave();
    for (let i = 0; i < 25; i++) {
      c.tick(1000);
      away.observe([{ ...row(String(i), "idle"), child: { title: `Task ${i}`, target: target(String(i)), handedOffTo: target(`${i}-new`, "codex") } }]);
    }
    c.tick(MIN_AWAY_MS);
    away.observeUsage(usage(0));
    away.back();
    expect(away.current()?.events).toHaveLength(20);
    expect(away.current()?.events[0].kind).toBe("quota");
    expect(away.current()?.events[1].title).toBe("Task 24 moved to Codex");
    expect(away.current()?.events.at(-1).title).toBe("Task 6 moved to Codex");
  });

  it.each(["section", "focus"])("records recovery on the shared usage feed while away by %s", (reason) => {
    vi.useFakeTimers();
    const win = new EventTarget();
    const doc = new EventTarget();
    let focused = true;
    Object.assign(doc, { hidden: false, hasFocus: () => focused });
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("location", { hash: "#/home" });
    sharedAway.dismiss();
    const stop = startAway();
    try {
      feeds.usage!(usage(100));
      if (reason === "section") feeds.section!("agents");
      else { focused = false; win.dispatchEvent(new Event("blur")); }
      vi.advanceTimersByTime(MIN_AWAY_MS);
      feeds.usage!(usage(0));
      expect(sharedAway.current()).toBeNull();
      if (reason === "section") feeds.section!("home");
      else { focused = true; win.dispatchEvent(new Event("focus")); }
      expect(sharedAway.current()?.events).toMatchObject([{ kind: "quota", title: "Claude · Work is available again (5-hour limit reset)" }]);
    } finally { feeds.usage!({ accounts: [] }); stop(); sharedAway.dismiss(); }
  });
});
