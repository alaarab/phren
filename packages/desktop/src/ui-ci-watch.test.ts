import { describe, expect, it } from "vitest";
import { checksStrip, ciTransitions, noteOwnAction, parsePullsKey, prKey, pullsKey, reviewLook, reviewNotice, reviewStep, watchedSessions } from "../ui/shell/ci-watch.js";

const pull = (checks: string | null) => ({ project: "phren", computer: "This computer", number: 42, title: "Keep the session", checks });

describe("ciTransitions", () => {
  it("announces checks that settle on failing or passing, never a first sighting or no change", () => {
    const previous = new Map([["a", pull("pending")], ["b", pull("passing")], ["c", pull("failing")]]);
    const current = new Map([["a", pull("failing")], ["b", pull("passing")], ["c", pull("pending")], ["d", pull("failing")]]);
    expect(ciTransitions(previous, current).map((p) => p.checks)).toEqual(["failing"]);
    expect(ciTransitions(new Map([["a", pull("failing")]]), new Map([["a", pull("passing")]]))).toHaveLength(1);
  });
});

describe("watchedSessions", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  const row = (computer: string, cwd: string, agentStatus: string, minutesAgo: number) => ({
    computer, child: { cwd, agentStatus, target: { id: cwd }, lastChangedAt: new Date(now - minutesAgo * 60_000).toISOString() },
  });

  it("keeps one session per computer and project, working or active in the last two hours", () => {
    const picked = watchedSessions([
      row("mini", "/home/you/phren", "idle", 10),
      row("mini", "/home/you/phren", "working", 5),
      row("mini", "/home/you/gitboy", "idle", 300),
      row("mini", "/home/you/old", "working", 600),
      row("laptop", "/home/you/phren", "idle", 30),
    ], now);
    expect(picked.map((w) => `${w.computer}/${w.project}`)).toEqual(["mini/phren", "laptop/phren", "mini/old"]);
    expect(picked[0].target).toEqual({ id: "/home/you/phren" });
  });
});

describe("checksStrip", () => {
  it("puts failing requests first, then running, passing and unchecked, newest first within each", () => {
    const pulls = [
      { ...pull("passing"), number: 7 }, { ...pull(null), number: 9 }, { ...pull("failing"), number: 3 },
      { ...pull("pending"), number: 5 }, { ...pull("failing"), number: 8 },
    ];
    expect(checksStrip(pulls).map((p) => `${p.checks}#${p.number}`)).toEqual(["failing#8", "failing#3", "pending#5", "passing#7", "null#9"]);
  });
});

describe("reviewStep", () => {
  type Seen = { decision?: string | null; mergeState?: string; conflicts?: boolean };
  /** Feed looks in order; the states that began at each. */
  const run = (looks: Seen[]) => {
    let known: ReturnType<typeof reviewStep>["next"] | undefined;
    return looks.map((look) => { const { next, began } = reviewStep(known, look); known = next; return began; });
  };

  it("announces each transition once and nothing on first sight", () => {
    expect(run([
      { decision: "CHANGES_REQUESTED", mergeState: "DIRTY" }, // first sight: baseline only
      { decision: "CHANGES_REQUESTED", mergeState: "DIRTY" },
      { decision: "REVIEW_REQUIRED", mergeState: "CLEAN" },
      { decision: "CHANGES_REQUESTED", mergeState: "CLEAN" },
      { decision: "CHANGES_REQUESTED", mergeState: "CLEAN" },
    ])).toEqual([[], [], [], ["changes"], []]);
  });

  it("announces approval only when it was not approved before; approved to approved is silent", () => {
    expect(run([{ decision: "REVIEW_REQUIRED" }, { decision: "APPROVED" }, { decision: "APPROVED" }, { decision: "REVIEW_REQUIRED" }, { decision: "APPROVED" }]))
      .toEqual([[], ["approved"], [], [], ["approved"]]);
  });

  it("announces conflicts again after they were cleared and came back", () => {
    expect(run([{ mergeState: "CLEAN" }, { mergeState: "DIRTY" }, { mergeState: "DIRTY" }, { mergeState: "BEHIND" }, { conflicts: true }]))
      .toEqual([[], ["conflicts"], [], [], ["conflicts"]]);
  });

  it("treats UNKNOWN and a missing decision as no information", () => {
    expect(run([{ mergeState: "DIRTY" }, { mergeState: "UNKNOWN" }, { mergeState: "DIRTY" }, {}, { mergeState: "DIRTY" }])).toEqual([[], [], [], [], []]);
    expect(run([{ decision: "APPROVED" }, { decision: null }, { decision: "APPROVED" }, {}, { decision: "APPROVED" }])).toEqual([[], [], [], [], []]);
    expect(run([{ decision: "CHANGES_REQUESTED" }, { decision: undefined }, { decision: "CHANGES_REQUESTED" }])).toEqual([[], [], []]);
  });

  it("clears a state only on a positive opposite value", () => {
    expect(run([{ decision: "APPROVED" }, { decision: "CHANGES_REQUESTED" }, { decision: "APPROVED" }])).toEqual([[], ["changes"], ["approved"]]);
    expect(run([{ mergeState: "DIRTY" }, { mergeState: "BLOCKED" }, { mergeState: "DIRTY" }])).toEqual([[], [], ["conflicts"]]);
  });

  it("titles each notice", () => {
    const pull = { project: "phren", computer: "mini", number: 42, title: "Keep the session", ref: "#" };
    expect((["changes", "approved", "conflicts"] as const).map((state) => reviewNotice({ pull, state }).title)).toEqual([
      "Changes requested on #42 Keep the session", "Approved: #42 Keep the session", "#42 Keep the session now has conflicts",
    ]);
  });
});

describe("prKey and pullsKey", () => {
  it("keys one request by host and repository across sessions, else by project", () => {
    expect(prKey({ number: 42, url: "https://github.com/Sam/phren/pull/42" }, "a")).toBe(prKey({ number: 42, url: "https://github.com/sam/phren/pull/42" }, "b"));
    expect(prKey({ number: 12, url: "https://gitlab.example.com/team/phren/-/merge_requests/12" }, "a")).toBe("https://gitlab.example.com/team/phren#12");
    expect(prKey({ number: 42 }, "phren")).toBe("phren#42");
  });

  it("round-trips a notification key with awkward characters", () => {
    const pull = { computer: "Mac mini|2", project: "my|proj", key: "Mac mini|2\u0000my|proj" };
    expect(parsePullsKey(pullsKey(pull))).toEqual({ computer: "Mac mini|2", project: "my|proj", session: pull.key });
    expect(parsePullsKey("some-session")).toBeNull();
  });
});

describe("reviewLook", () => {
  const w = (key: string, at: string) => ({ key, project: "phren", computer: key, child: { lastChangedAt: at } });
  const seen = (key: string, at: string, pull: object) => ({ w: w(key, at), ref: "#", pull: { number: 42, title: "T", url: "https://github.com/sam/phren/pull/42", ...pull } });
  const H = 3_600_000;

  it("announces one request once, carried by the most recently active session", () => {
    const reviews = new Map();
    reviewLook(reviews, [seen("mini", "2026-10-16T10:00:00Z", {}), seen("laptop", "2026-10-16T11:00:00Z", {})], 0);
    const out = reviewLook(reviews, [
      seen("mini", "2026-10-16T10:00:00Z", { reviewDecision: "CHANGES_REQUESTED" }),
      seen("laptop", "2026-10-16T11:00:00Z", { reviewDecision: "CHANGES_REQUESTED" }),
    ], 1);
    expect(out.map((c) => [c.state, c.pull.key])).toEqual([["changes", "laptop"]]);
  });

  it("keeps a baseline through a gap shorter than the grace period, and drops it after", () => {
    const reviews = new Map();
    reviewLook(reviews, [seen("mini", "2026-10-16T10:00:00Z", { reviewDecision: "REVIEW_REQUIRED" })], 0);
    expect(reviewLook(reviews, [], 5 * H)).toEqual([]);
    expect(reviewLook(reviews, [seen("mini", "2026-10-16T10:00:00Z", { reviewDecision: "APPROVED" })], 5.5 * H).map((c) => c.state)).toEqual(["approved"]);
    reviewLook(reviews, [], 5.5 * H + 7 * H);
    expect(reviews.size).toBe(0);
    expect(reviewLook(reviews, [seen("mini", "2026-10-16T10:00:00Z", { reviewDecision: "CHANGES_REQUESTED" })], 13 * H)).toEqual([]);
  });

  it("is silent for a change right after the owner's own action", () => {
    const reviews = new Map();
    const pull = { number: 42, url: "https://github.com/sam/phren/pull/42", project: "phren" };
    reviewLook(reviews, [seen("mini", "2026-10-16T10:00:00Z", { reviewDecision: "REVIEW_REQUIRED" })], 1000);
    noteOwnAction(pull, 1000);
    expect(reviewLook(reviews, [seen("mini", "2026-10-16T10:00:00Z", { reviewDecision: "APPROVED" })], 60_000)).toEqual([]);
    expect(reviewLook(reviews, [seen("mini", "2026-10-16T10:00:00Z", { reviewDecision: "CHANGES_REQUESTED" })], 61_000)).toEqual([]);
    noteOwnAction(pull, 1000);
    reviewLook(reviews, [seen("mini", "2026-10-16T10:00:00Z", { reviewDecision: "REVIEW_REQUIRED" })], 2000);
    expect(reviewLook(reviews, [seen("mini", "2026-10-16T10:00:00Z", { reviewDecision: "APPROVED" })], 200_000).map((c) => c.state)).toEqual(["approved"]);
  });
});
