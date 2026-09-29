import { describe, expect, it } from "vitest";
import { isBriefTitle, markBackground, meaningfulLabel, ownRecord, recordedBackground, sessionTitle } from "./session-activity.js";
import { nextTurn, type TurnRecord } from "./turn-records.js";

const session = "00000001-1111-4111-8111-111111111111";
const pane = { pane_id: "w1:p1", terminal_id: "term_a" };
function record(background?: number, dispatch?: string): TurnRecord {
  let value = nextTurn(undefined, { event: "UserPromptSubmit", terminal: "term_a", source: "claude", session, dispatch })!;
  value = nextTurn(value, { event: "Stop", terminal: "term_a", source: "claude", session, background })!;
  return value;
}

describe("background work keeps a session working", () => {
  it("turns an ended turn with background tasks into working with a count", () => {
    const tab: Record<string, unknown> = { agentStatus: "idle" };
    markBackground(tab, recordedBackground(record(5)));
    expect(tab).toEqual({ agentStatus: "working", backgroundTasks: 5 });
    const done: Record<string, unknown> = { agentStatus: "done" };
    markBackground(done, 1);
    expect(done).toEqual({ agentStatus: "working", backgroundTasks: 1 });
  });

  it("takes the larger of two counts, never the sum", () => {
    const tab: Record<string, unknown> = { agentStatus: "idle" };
    markBackground(tab, 5); markBackground(tab, 2);
    expect(tab.backgroundTasks).toBe(5);
    markBackground(tab, 7);
    expect(tab.backgroundTasks).toBe(7);
    const children: Record<string, unknown> = { agentStatus: "idle" };
    markBackground(children, 3);
    expect(children).toEqual({ agentStatus: "working", backgroundTasks: 3 });
  });

  it("leaves a tab with a live turn, and a turn with nothing pending, alone", () => {
    for (const status of ["working", "blocked", "waiting", "unknown"]) {
      const tab: Record<string, unknown> = { agentStatus: status };
      markBackground(tab, 4);
      expect(tab).toEqual({ agentStatus: status });
    }
    const idle: Record<string, unknown> = { agentStatus: "idle" };
    markBackground(idle, recordedBackground(record(0)));
    markBackground(idle, 0);
    expect(idle).toEqual({ agentStatus: "idle" });
    // A turn still running has no ended Stop to count.
    expect(recordedBackground(nextTurn(undefined, { event: "UserPromptSubmit", terminal: "term_a", source: "claude", session }))).toBeUndefined();
  });

  it("trusts a record only for this pane's terminal, agent and conversation", () => {
    const value = record(2);
    expect(ownRecord(value, pane, "claude", session)).toBe(value);
    expect(ownRecord(value, pane, "claude", "00000002-1111-4111-8111-111111111111")).toBeUndefined();
    expect(ownRecord(value, { ...pane, terminal_id: "term_b" }, "claude", session)).toBeUndefined();
    expect(ownRecord(value, pane, "codex", session)).toBeUndefined();
    expect(ownRecord(value, pane, "claude", undefined)).toBeUndefined();
  });
});

describe("session titles", () => {
  it("recognizes the titles a brief launch produces", () => {
    for (const title of ["Read and follow the brief in /x/briefs/abc/brief.md", "read and follow the brief", "Fix /home/a/briefs/x/brief.md",
      "Brief d35c6189", "Brief ec1340da-5c34-…", "Brief ec1340da-5c34-4b1a...", "Brief ec1340da-5c34-4b1a-9c1d-000000000001"]) expect(isBriefTitle(title), title).toBe(true);
    for (const title of ["Brief review", "Bridge brief review", "Fix the brief parser", "Desk session 1"]) expect(isBriefTitle(title), title).toBe(false);
  });

  it("does not take Herdr's bare numbers or ids as names", () => {
    expect(meaningfulLabel("parser checks")).toBe("parser checks");
    for (const value of ["", "  ", "1", "w13:t2", "w1P:p2", "t3", undefined, 4]) expect(meaningfulLabel(value), String(value)).toBeUndefined();
  });

  it("prefers the dispatch label, then the tab and workspace labels for a dispatch without one, then the harness title", () => {
    const base = { harnessTitle: "Read and follow the brief in /x/briefs/abc/brief.md", tabLabel: "3", workspaceLabel: "app" };
    expect(sessionTitle({ ...base, dispatched: true, dispatchLabel: "parser checks" })).toBe("parser checks");
    expect(sessionTitle({ ...base, dispatched: true })).toBe("app");
    expect(sessionTitle({ ...base, dispatched: true, tabLabel: "nav checks" })).toBe("nav checks");
    // Even a dispatched worker with no usable label is never shown the brief prompt.
    expect(sessionTitle({ ...base, dispatched: true, workspaceLabel: "2" })).toBeUndefined();
    expect(sessionTitle({ harnessTitle: "Fix the parser", tabLabel: "nav", workspaceLabel: "app", dispatched: false })).toBe("Fix the parser");
    expect(sessionTitle({ ...base, dispatched: false })).toBe("app");
    expect(sessionTitle({ harnessTitle: "Brief d35c6189", tabLabel: "1", workspaceLabel: "2", dispatched: false })).toBeUndefined();
    expect(sessionTitle({ tabLabel: "nav", workspaceLabel: "app", dispatched: false })).toBeUndefined();
  });

  it("falls back to the raw harness title rather than leave a row blank", () => {
    const brief = "Read and follow the brief in /x/briefs/abc/brief.md";
    // The label the phone falls back to is blank or missing: the raw title stands.
    expect(sessionTitle({ harnessTitle: brief, tabLabel: "1", workspaceLabel: "2", dispatched: true, fallbackLabel: "" })).toBe(brief);
    expect(sessionTitle({ harnessTitle: brief, tabLabel: "1", workspaceLabel: "2", dispatched: false, fallbackLabel: "  " })).toBe(brief);
    expect(sessionTitle({ harnessTitle: brief, dispatched: false, fallbackLabel: undefined })).toBe(brief);
    // A usable fallback label keeps the title dropped; a chosen title is unchanged; no title stays undefined.
    expect(sessionTitle({ harnessTitle: brief, tabLabel: "1", workspaceLabel: "2", dispatched: true, fallbackLabel: "1" })).toBeUndefined();
    expect(sessionTitle({ harnessTitle: "Fix it", dispatched: false, fallbackLabel: "" })).toBe("Fix it");
    expect(sessionTitle({ dispatched: true, fallbackLabel: "" })).toBeUndefined();
  });

  it("names a session by its pane label ahead of the dispatch label, harness title and tab label", () => {
    const base = { harnessTitle: "Fix the parser", tabLabel: "nav", workspaceLabel: "app" };
    expect(sessionTitle({ ...base, dispatched: false, paneLabel: "Tide charts" })).toBe("Tide charts");
    expect(sessionTitle({ ...base, dispatched: true, dispatchLabel: "parser checks", paneLabel: "Tide charts" })).toBe("Tide charts");
    // A pane has no label until someone sets one, and Herdr's bare numbering is not a name.
    expect(sessionTitle({ ...base, dispatched: true, dispatchLabel: "parser checks", paneLabel: undefined })).toBe("parser checks");
    expect(sessionTitle({ ...base, dispatched: false, paneLabel: "2" })).toBe("Fix the parser");
  });
});
