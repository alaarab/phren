import { afterEach, describe, expect, it, vi } from "vitest";
import { quotaDestinations, quotaDestinationText, quotaPreferences, quotaSessionKey, quotaWarnings, quotaInteractionPending, sessionUsage } from "../ui/shell/quota-warn.js";
import { loadQuotaState, markQuotaSeen, quotaSeen, quotaSettings, quotaSuppressed, saveQuotaSettings, suppressQuotaChat } from "../ui/shell/quota-warn-prefs.js";

const now = Date.parse("2026-10-14T12:00:00Z");
const reset = "2026-10-14T14:00:00Z";
const session = { computer: "Desk", child: { id: "tab1", account: { id: "work" }, target: { source: "claude", session: "chat1" } } };
const row = (used = 92, id = "five_hour", resetsAt = reset) => ({ id: "claude|work", harness: "claude", computers: [{ name: "Desk", account: "work" }], windows: [{ id, usedPercent: used, resetsAt }] });
const warnings = (usage = row(), options = {}) => quotaWarnings(session, usage, { now, ...options });

afterEach(() => vi.unstubAllGlobals());

describe("chat quota decisions", () => {
  it.each([50, 90, 99])("warns at the configured %i percent boundary", (threshold) => {
    expect(warnings(row(threshold - 0.1), { preferences: { threshold } })).toEqual([]);
    expect(warnings(row(threshold), { preferences: { threshold } })).toMatchObject([{ stage: "near", used: threshold }]);
  });

  it("does not repeat a threshold, but announces exhaustion independently", () => {
    const seen = warnings().map((w) => w.token);
    expect(warnings(row(97), { seen })).toEqual([]);
    const exhausted = warnings(row(100), { seen });
    expect(exhausted).toMatchObject([{ stage: "exhausted" }]);
    seen.push(exhausted[0].token);
    expect(warnings(row(100), { seen })).toEqual([]);
    expect(warnings(row(91), { seen })).toEqual([]);
  });

  it("keeps weekly, reset periods and conversations independent", () => {
    const seen = warnings().map((w) => w.token);
    expect(warnings(row(92, "seven_day"), { seen })).toMatchObject([{ label: "weekly" }]);
    expect(warnings(row(92, "five_hour", "2026-10-14T19:00:00Z"), { seen })).toHaveLength(1);
    expect(quotaWarnings({ ...session, child: { ...session.child, target: { source: "claude", session: "chat2" } } }, row(), { now, seen })).toHaveLength(1);
  });

  it("warns on service refusal and leftPercent-only windows, skipping expired or unknown windows", () => {
    const usage = row();
    usage.windows = [
      { id: "five_hour", limited: true, resetsAt: reset },
      { id: "seven_day", leftPercent: 8, resetsAt: reset },
    ];
    expect(warnings(usage).map((w) => [w.label, w.stage])).toEqual([["5-hour", "exhausted"], ["weekly", "near"]]);
    expect(warnings(row(100, "five_hour", "2026-10-14T11:00:00Z"))).toEqual([]);
    expect(warnings({ ...usage, windows: [{ id: "five_hour" }, { id: "seven_day", usedPercent: 100, reset: true }] })).toEqual([]);
  });

  it("honours off, chat suppression and stale or absent usage", () => {
    expect(warnings(row(), { preferences: { on: false } })).toEqual([]);
    expect(warnings(row(), { suppressed: [quotaSessionKey(session)] })).toEqual([]);
    expect(warnings({ ...row(), stale: true })).toEqual([]);
    expect(quotaWarnings(session, null, { now })).toEqual([]);
  });

  it("matches the session's account on its computer, never the email or another login", () => {
    const work = row();
    const other = { ...row(99), id: "claude|personal", computers: [{ name: "Desk", account: "default" }] };
    expect(sessionUsage(session, [other, work])).toBe(work);
    expect(sessionUsage(session, [other])).toBeNull();
    expect(sessionUsage({ ...session, child: { ...session.child, account: undefined } }, [work])).toBeNull();
    expect(sessionUsage(session, [{ ...work, computers: [{ name: "Laptop", account: "work" }] }])).toBeNull();
    expect(sessionUsage(session, [work, { ...work, id: "ambiguous" }])).toBeNull();
    expect(sessionUsage(session, [{ ...work, stale: true }])).toBeNull();
  });

  it("uses a unique Codex account on this computer and recognises both windows", () => {
    const codex = { ...session, child: { id: "tab2", target: { source: "codex", session: "c2" } } };
    const usage = { id: "codex|login", harness: "codex", computers: [{ name: "Desk" }], windows: [{ id: "codex:primary", usedPercent: 93 }, { id: "codex:secondary", exhausted: true }] };
    expect(sessionUsage(codex, [usage])).toBe(usage);
    expect(quotaWarnings(codex, usage, { now }).map((w) => [w.label, w.stage])).toEqual([["weekly", "exhausted"], ["5-hour", "near"]]);
  });

  it("ranks available destinations by the tightest window, keeping exhausted and unknown explicit", () => {
    const claude = (id: string, used: number, week = used) => ({ ...row(used), id: `claude|${id}`, computers: [{ name: "Desk", account: id }], windows: [{ id: "five_hour", usedPercent: used }, { id: "seven_day", usedPercent: week }] });
    const usage = [row(), claude("default", 20, 80), claude("spare", 40), claude("empty", 100), { id: "codex", harness: "codex", computers: [{ name: "Desk" }], windows: [{ id: "codex:primary", usedPercent: 30 }] }];
    const destinations = quotaDestinations(session, [{ source: "codex", label: "Codex", usable: true }, { source: "opencode", label: "OpenCode", usable: true }, { source: "copilot", usable: false }], ["work", "default", "spare", "empty"].map((id) => ({ id })), usage, now);
    expect(destinations.map((d) => [d.harness, d.account, d.left, d.exhausted])).toEqual([
      ["codex", undefined, 70, false], ["claude", "spare", 60, false], ["claude", "default", 20, false], ["opencode", undefined, null, false], ["claude", "empty", 0, true],
    ]);
  });

  it("describes the tightest window with its own reset rather than another window's", () => {
    const reset = new Date(2026, 9, 15, 9, 0);
    const at = new Date(2026, 9, 14, 8, 0).getTime();
    const destinations = quotaDestinations(session, [], [{ id: "personal", label: "Personal" }], [{ id: "personal", harness: "claude", computers: [{ name: "Desk", account: "personal" }], windows: [
      { id: "five_hour", usedPercent: 10, resetsAt: new Date(at + 3 * 3600_000).toISOString() },
      { id: "seven_day", usedPercent: 22, resetsAt: reset.toISOString() },
    ] }], at);
    expect(quotaDestinationText(destinations[0], at)).toBe("Claude · Personal · 78% left of weekly · resets Thu 09:00");
    expect(quotaDestinationText({ label: "Codex", left: 60, limiting: { id: "codex:primary", resetsAt: new Date(at + 3 * 3600_000).toISOString() } }, at)).toBe("Codex · 60% left of 5-hour · resets in 3h");
  });

  it.each([
    [undefined, true], [{}, false], [{ pendingApproval: { actionId: "a" } }, true],
    [{ pendingQuestions: [{ questions: [{ question: "Choose" }] }] }, true],
    [{ terminalPrompt: { questions: [{ question: "Continue?" }] } }, true],
    [{ passwordPrompt: true }, true], [{ pendingQuestions: [] }, false],
  ])("gives interaction cards priority for status %j", (status, expected) => {
    expect(quotaInteractionPending(status)).toBe(expected);
  });

  it("defaults to enabled at 90 and validates saved thresholds", async () => {
    expect(quotaPreferences()).toEqual({ on: true, backOn: true, threshold: 90 });
    for (const threshold of [null, "bad", 49, 100]) expect(quotaPreferences({ threshold }).threshold).toBe(90);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ settings: { on: true, backOn: true, threshold: 90 }, suppressed: [], seen: [] }) })));
    await loadQuotaState();
    await saveQuotaSettings({ threshold: 95, on: false });
    expect(quotaSettings()).toEqual({ on: false, backOn: true, threshold: 95 });
    await saveQuotaSettings({ backOn: false });
    expect(quotaSettings()).toEqual({ on: false, backOn: false, threshold: 95 });
    expect(JSON.parse(vi.mocked(fetch).mock.calls.at(-1)![1]!.body as string).settings.backOn).toBe(false);
    await suppressQuotaChat(quotaSessionKey(session));
    await markQuotaSeen("shown-token");
    expect(quotaSuppressed()).toContain(quotaSessionKey(session));
    expect(quotaSeen()).toContain("shown-token");
  });
});
