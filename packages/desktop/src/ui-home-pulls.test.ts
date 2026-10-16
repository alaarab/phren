import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without declarations
import { inboxRows, inboxWords, pullRank } from "../ui/sections/home/pulls.js";
// @ts-expect-error plain ESM without declarations
import { createLimiter, createPullsFeed, freshProjectGit, planRead, rememberProjectGit, rememberFailure, resetProjectPulls, CADENCE_FOCUSED_MS, CADENCE_BLURRED_MS, COLD_MS, DROP_MS, SKIP_MS, PAGE_FRESH_MS } from "../ui/shell/project-pulls.js";

const github = { kind: "github", name: "GitHub", webUrl: "https://github.com/you/phren", terms: { short: "PR", long: "pull request", ref: "#" } };
const gitlab = { kind: "gitlab", name: "GitLab", webUrl: "https://gitlab.com/you/api", terms: { short: "MR", long: "merge request", ref: "!" } };
const read = (computer: string, project: string, host: object, pulls: object[], current: object | null = null) => ({ computer, project, directory: `/w/${project}`, data: { available: true, host, pulls, current } });
const iso = (minutesAgo: number) => new Date(Date.UTC(2026, 9, 15, 12) - minutesAgo * 60_000).toISOString();

describe("pullRank", () => {
  it("puts conflicts, changes requested and failing checks before ready and the rest", () => {
    const rank = (fields: object) => pullRank({ conflicts: false, review: "", checks: "", draft: false, ...fields });
    expect(rank({ conflicts: true, checks: "failing" })).toBe(0);
    expect(rank({ review: "CHANGES_REQUESTED", checks: "failing" })).toBe(1);
    expect(rank({ checks: "failing" })).toBe(2);
    expect(rank({ review: "APPROVED", checks: "passing" })).toBe(3);
    expect(rank({ review: "APPROVED", checks: "passing", draft: true })).toBe(4);
    expect(rank({ review: "APPROVED", checks: "pending" })).toBe(4);
    expect(rank({})).toBe(4);
  });
});

describe("inboxRows", () => {
  it("orders by need, then newest first, with the rest after", () => {
    const rows = inboxRows([
      read("Desk", "phren", github, [
        { number: 1, title: "old plain", updated: iso(500) },
        { number: 2, title: "new plain", updated: iso(5) },
        { number: 3, title: "approved", updated: iso(60), reviewDecision: "APPROVED", checks: "passing", mergeState: "CLEAN" },
        { number: 4, title: "failing", updated: iso(90), checks: "failing" },
        { number: 5, title: "asked", updated: iso(120), reviewDecision: "CHANGES_REQUESTED" },
        { number: 6, title: "dirty", updated: iso(300), mergeState: "DIRTY" },
        { number: 7, title: "failing newer", updated: iso(30), checks: "failing" },
      ]),
    ]);
    expect(rows.map((r: { number: number }) => r.number)).toEqual([6, 5, 7, 4, 3, 2, 1]);
  });

  it("counts the same repository and number once across computers, keeping the richer read", () => {
    const rows = inboxRows([
      read("Desk", "phren", github, [{ number: 9, title: "Add search", updated: iso(10) }]),
      read("Mini", "phren", { ...github, webUrl: "https://github.com/you/phren/" }, [{ number: 9, title: "Add search", updated: iso(10), checks: "failing" }]),
      read("Mini", "other", { ...github, webUrl: "https://github.com/you/other" }, [{ number: 9, title: "Different repo", updated: iso(10) }]),
    ]);
    expect(rows).toHaveLength(2);
    const mine = rows.find((r: { title: string }) => r.title === "Add search");
    expect(mine).toMatchObject({ checks: "failing", rank: 2, computer: "Mini" });
  });

  it("reads the checked-out branch's request in full, and conflicts, behind and draft from the host's words", () => {
    const rows = inboxRows([
      read("Desk", "phren", github, [{ number: 1, title: "t", draft: false }, { number: 2, title: "u", mergeState: "BEHIND" }, { number: 3, title: "d", draft: true }, { number: 4, title: "c", conflicts: true }],
        { number: 1, title: "t", reviewDecision: "APPROVED", checks: "passing", mergeState: "CLEAN" }),
    ]);
    const by = (n: number) => rows.find((r: { number: number }) => r.number === n);
    expect(by(1)).toMatchObject({ review: "APPROVED", checks: "passing", rank: 3 });
    expect(by(2)).toMatchObject({ behind: true, conflicts: false });
    expect(by(3)).toMatchObject({ draft: true });
    expect(by(4)).toMatchObject({ conflicts: true, rank: 0 });
  });

  it("skips projects without a list and entries without a number", () => {
    expect(inboxRows([{ computer: "Desk", project: "p", directory: "", data: { available: false } }, read("Desk", "q", github, [{ title: "no number" }])])).toEqual([]);
  });

  it("uses the host's own words", () => {
    expect(inboxWords(inboxRows([read("Desk", "api", gitlab, [{ number: 3, title: "x" }])]))).toEqual({ plural: "merge requests", short: "MRs" });
    expect(inboxWords(inboxRows([read("Desk", "api", gitlab, [{ number: 3, title: "x" }]), read("Desk", "phren", github, [{ number: 4, title: "y" }])]))).toEqual({ plural: "pull and merge requests", short: "requests" });
  });
});

describe("inboxRows details", () => {
  it("never merges different repositories on one domain, and prefers a current read over a stale copy", () => {
    const rows = inboxRows([
      { ...read("Desk", "a", { kind: "gitboy", name: "gitboy", domain: "git.example.com", remote: "origin" }, [{ number: 1, title: "one" }]) },
      { ...read("Desk", "b", { kind: "gitboy", name: "gitboy", domain: "git.example.com", remote: "origin" }, [{ number: 1, title: "two" }]) },
      { ...read("Desk", "c", github, [{ number: 5, title: "old copy", checks: "failing" }]), stale: true, at: 5 },
      { ...read("Mini", "c", github, [{ number: 5, title: "current copy" }]), at: 1 },
    ]);
    expect(rows.map((r: { title: string }) => r.title).sort()).toEqual(["current copy", "one", "two"]);
  });

  it("sorts a stale read below every urgent one, whitelists checks, and marks the viewer's own requests", () => {
    const rows = inboxRows([
      { ...read("Desk", "p", github, [{ number: 1, title: "stale conflict", mergeState: "DIRTY" }]), stale: true },
      { ...read("Mini", "q", { ...github, webUrl: "https://github.com/you/q" }, [{ number: 2, title: "plain", author: "You", checks: "x\" onmouseover=\"y" }]), data: { available: true, host: { ...github, webUrl: "https://github.com/you/q" }, account: { user: "you" }, pulls: [{ number: 2, title: "plain", author: "You", checks: "x\" onmouseover=\"y" }] } },
    ]);
    expect(rows.map((r: { number: number }) => r.number)).toEqual([2, 1]);
    expect(rows[0]).toMatchObject({ checks: "", mine: true });
    expect(rows[1]).toMatchObject({ stale: true, rank: 5 });
  });
});

describe("the load budget", () => {
  beforeEach(() => resetProjectPulls());
  const good = { available: true, host: github, pulls: [{ number: 1, title: "t" }] };

  it("plans a fetch for nothing or an attempt older than the cadence, and none for a recent attempt or a live skip", () => {
    const at = 1_000_000;
    expect(planRead(undefined, at, CADENCE_FOCUSED_MS)).toBe("fetch");
    expect(planRead({ at, tried: at, data: {} }, at + CADENCE_FOCUSED_MS - 1, CADENCE_FOCUSED_MS)).toBe("skip");
    expect(planRead({ at, tried: at, data: {} }, at + CADENCE_FOCUSED_MS, CADENCE_FOCUSED_MS)).toBe("fetch");
    expect(planRead({ at, tried: at, skipUntil: at + SKIP_MS }, at + SKIP_MS - 1, 0)).toBe("skip");
    expect(planRead({ at, tried: at, skipUntil: at + SKIP_MS }, at + SKIP_MS, 0)).toBe("fetch");
  });

  it("keeps good data through a transient failure (stale, no skip) and skips only for no host, no sign-in or no checkout", () => {
    expect(rememberProjectGit("Desk", "p", good, 1000)).toBe("ok");
    expect(freshProjectGit("Desk", "p", 1000 + PAGE_FRESH_MS - 1)).not.toBeNull();
    expect(rememberProjectGit("Desk", "p", { available: false, reason: "unreachable", host: github }, 2000)).toBe("stale");
    expect(freshProjectGit("Desk", "p", 2500)).toBeNull();
    expect(rememberProjectGit("Desk", "p", { available: false, reason: "auth", host: github }, 3000)).toBe("stale");
    // Never read: a transient answer is a failed read with no skip; the permanent ones skip for ten minutes.
    expect(rememberProjectGit("Desk", "t", { available: false, reason: "failed", host: github }, 1000)).toBe("failed");
    expect(rememberProjectGit("Desk", "u", { available: false, reason: "auth", host: github }, 1000)).toBe("skip");
    expect(rememberProjectGit("Desk", "v", { available: true, host: { kind: null } }, 1000)).toBe("skip");
    expect(rememberFailure("Desk", "w", 1000)).toBe("failed");
  });

  it("runs at most two requests per computer and four in all", async () => {
    const limit = createLimiter();
    let running = 0;
    const byComputer = new Map<string, number>();
    let peak = 0;
    const peakBy = new Map<string, number>();
    const job = (computer: string) => limit(computer, async () => {
      running++; byComputer.set(computer, (byComputer.get(computer) ?? 0) + 1);
      peak = Math.max(peak, running); peakBy.set(computer, Math.max(peakBy.get(computer) ?? 0, byComputer.get(computer)!));
      await new Promise((r) => setTimeout(r, 5));
      running--; byComputer.set(computer, byComputer.get(computer)! - 1);
    });
    await Promise.all(["a", "a", "a", "a", "b", "b", "b", "c", "c", "d", "d", "e"].map(job));
    expect(peak).toBeLessThanOrEqual(4);
    expect(Math.max(...peakBy.values())).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(2);
  });

  function feedFor(options: { repos?: Record<string, object[]>; answers?: Record<string, (project: string) => unknown>; visible?: () => boolean; clock?: { t: number }; active?: (c: string, p: string) => boolean; ready?: (c: string) => boolean; cadence?: () => number }) {
    const calls: string[] = [];
    const updates: Array<{ pulls: unknown[]; loading: boolean; failed: boolean; unread: number; unreadComputers: number }> = [];
    const clock = options.clock ?? { t: 0 };
    const feed = createPullsFeed({
      computers: () => Object.keys(options.repos ?? {}),
      onUpdate: (u: never) => updates.push(u),
      canRead: options.visible ?? (() => true),
      active: options.active, ready: options.ready, cadence: options.cadence ?? (() => CADENCE_FOCUSED_MS),
      now: () => clock.t,
      get: async (computer: string, route: string) => {
        calls.push(`${computer} ${route}`);
        if (route === "/v1/projects/repos") return { repos: options.repos![computer] };
        const project = decodeURIComponent(route.split("/")[3]);
        const answer = options.answers?.[computer]?.(project);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    return { feed, calls, updates, clock };
  }
  const registered = (...names: string[]) => names.map((name) => ({ name, directory: `/w/${name}`, registered: true }));
  const open = (n: number) => ({ available: true, host: github, pulls: [{ number: n, title: "t" }] });
  const reads = (calls: string[]) => calls.filter((c) => c.endsWith("/git")).length;

  it("reads a project with open requests every five minutes, and one without a session or request every thirty", async () => {
    const { feed, calls, clock } = feedFor({ repos: { Desk: registered("hot", "cold") }, answers: { Desk: (p) => p === "hot" ? open(1) : { available: true, host: github, pulls: [] } }, active: (_c, p) => p === "hot" });
    await feed.read();
    expect(reads(calls)).toBe(2);
    clock.t = CADENCE_FOCUSED_MS - 1;
    await feed.read();
    expect(reads(calls)).toBe(2);
    clock.t = CADENCE_FOCUSED_MS;
    await feed.read();
    expect(calls.filter((c) => c.includes("/hot/git"))).toHaveLength(2);
    expect(calls.filter((c) => c.includes("/cold/git"))).toHaveLength(1);
    clock.t = COLD_MS;
    await feed.read();
    expect(calls.filter((c) => c.includes("/cold/git"))).toHaveLength(2);
    expect(calls.filter((c) => c.endsWith("/repos")).length).toBeLessThanOrEqual(3);
  });

  it("reads at the unfocused cadence, and a forced round reads everything now", async () => {
    const { feed, calls, clock } = feedFor({ repos: { Desk: registered("a") }, answers: { Desk: () => open(1) }, cadence: () => CADENCE_BLURRED_MS });
    await feed.read();
    clock.t = CADENCE_FOCUSED_MS + 1;
    await feed.read();
    expect(reads(calls)).toBe(1);
    await feed.read({ force: true });
    expect(reads(calls)).toBe(2);
  });

  it("leaves a computer that is stressed or low on battery alone, and keeps showing what it said", async () => {
    let ok = true;
    const { feed, calls, updates, clock } = feedFor({ repos: { Desk: registered("a") }, answers: { Desk: () => open(1) }, ready: () => ok });
    await feed.read();
    ok = false;
    clock.t = CADENCE_FOCUSED_MS + 1;
    await feed.read();
    expect(reads(calls)).toBe(1);
    expect(updates.at(-1)!.pulls).toHaveLength(1);
  });

  it("leaves a project with no host or no checkout alone for ten minutes", async () => {
    const { feed, calls, clock } = feedFor({
      repos: { Desk: registered("plain", "gone") },
      answers: { Desk: (p) => p === "gone" ? Object.assign(new Error("none"), { status: 404 }) : { available: false, reason: "unknown-host", host: { kind: null } } },
    });
    await feed.read();
    clock.t = SKIP_MS - 1;
    await feed.read({});
    expect(reads(calls)).toBe(2);
    clock.t = SKIP_MS + COLD_MS;
    await feed.read();
    expect(reads(calls)).toBe(4);
  });

  it("keeps old rows through a transient failure, marks them stale and counts the project unread", async () => {
    let down = false;
    const { feed, updates, clock } = feedFor({ repos: { Desk: registered("a", "b") }, answers: { Desk: (p) => down && p === "a" ? { available: false, reason: "unreachable", host: github } : open(p === "a" ? 1 : 2) } });
    await feed.read();
    down = true;
    clock.t = CADENCE_FOCUSED_MS;
    await feed.read();
    const last = updates.at(-1) as { pulls: Array<{ project: string; stale: boolean }>; unread: number; failed: boolean };
    expect(last.pulls.map((p) => [p.project, p.stale])).toEqual([["a", true], ["b", false]]);
    expect(last).toMatchObject({ unread: 1, failed: false });
    // Past twenty minutes without a good read, the old rows go.
    clock.t = CADENCE_FOCUSED_MS * 2;
    await feed.read();
    clock.t = DROP_MS + 10;
    await feed.read();
    expect((updates.at(-1) as { pulls: unknown[] }).pulls.length).toBeLessThan(2);
  });

  it("asks nothing while hidden, and reports an error only when every read failed", async () => {
    const visible = false;
    const first = feedFor({ repos: { Desk: registered("a") }, visible: () => visible });
    await first.feed.read();
    expect(first.calls).toEqual([]);
    expect(first.updates).toEqual([]);

    resetProjectPulls();
    const down = feedFor({ repos: { Desk: registered("a", "b") }, answers: { Desk: () => new Error("offline") } });
    await down.feed.read();
    expect(down.updates[0]).toMatchObject({ loading: true });
    expect(down.updates.at(-1)).toMatchObject({ loading: false, failed: true, pulls: [] });

    resetProjectPulls();
    const partly = feedFor({ repos: { Desk: registered("a", "b") }, answers: { Desk: (p) => p === "a" ? open(1) : new Error("offline") } });
    await partly.feed.read();
    expect(partly.updates.at(-1)).toMatchObject({ loading: false, failed: false, unread: 1 });
    expect((partly.updates.at(-1) as { pulls: unknown[] }).pulls).toHaveLength(1);
  });

  it("does not send a read that was queued when the page was hidden", async () => {
    let visible = true;
    const { feed, calls } = feedFor({ repos: { Desk: registered("a", "b", "c", "d", "e") }, answers: { Desk: () => { visible = false; return open(1); } }, visible: () => visible });
    await feed.read();
    expect(reads(calls)).toBeLessThanOrEqual(2);
  });
});
