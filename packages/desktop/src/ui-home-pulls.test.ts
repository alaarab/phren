import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without declarations
import { inboxRows, inboxWords, pullRank } from "../ui/sections/home/pulls.js";
// @ts-expect-error plain ESM without declarations
import { createLimiter, createPullsFeed, freshProjectGit, planRead, rememberProjectGit, resetProjectPulls, PULLS_FRESH_MS, PULLS_SKIP_MS } from "../ui/shell/project-pulls.js";

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
    expect(mine).toMatchObject({ checks: "failing", rank: 2, computer: "Desk" });
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

describe("the load budget", () => {
  beforeEach(() => resetProjectPulls());

  it("plans a fetch for nothing, a stale read or an expired skip, and none for a fresh read or a live skip", () => {
    const at = 1_000_000;
    expect(planRead(undefined, at)).toBe("fetch");
    expect(planRead({ at, data: {} }, at + PULLS_FRESH_MS - 1)).toBe("use");
    expect(planRead({ at, data: {} }, at + PULLS_FRESH_MS)).toBe("fetch");
    expect(planRead({ at, skipUntil: at + PULLS_SKIP_MS }, at + PULLS_SKIP_MS - 1)).toBe("skip");
    expect(planRead({ at, skipUntil: at + PULLS_SKIP_MS }, at + PULLS_SKIP_MS)).toBe("fetch");
  });

  it("shares a project page's read, and skips a host that has nothing to say for ten minutes", () => {
    rememberProjectGit("Desk", "phren", { available: true, host: github, pulls: [] }, 1000);
    expect(freshProjectGit("Desk", "phren", 1000 + PULLS_FRESH_MS - 1)).not.toBeNull();
    expect(freshProjectGit("Desk", "phren", 1000 + PULLS_FRESH_MS)).toBeNull();
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

  function feedFor(options: { repos?: Record<string, object[]>; answers?: Record<string, (project: string) => unknown>; visible?: () => boolean; clock?: { t: number } }) {
    const calls: string[] = [];
    const updates: Array<{ pulls: unknown[]; loading: boolean; failed: boolean }> = [];
    const clock = options.clock ?? { t: 0 };
    const feed = createPullsFeed({
      computers: () => Object.keys(options.repos ?? {}),
      onUpdate: (u: never) => updates.push(u),
      canRead: options.visible ?? (() => true),
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

  it("reads each project once per two minutes and each computer's project list once", async () => {
    const { feed, calls, clock } = feedFor({ repos: { Desk: registered("a", "b") }, answers: { Desk: () => open(1) } });
    await feed.read();
    expect(calls).toHaveLength(3);
    clock.t = 60_000;
    await feed.read();
    expect(calls).toHaveLength(3);
    clock.t = PULLS_FRESH_MS + 1;
    await feed.read();
    expect(calls.filter((c) => c.endsWith("/git"))).toHaveLength(4);
    expect(calls.filter((c) => c.endsWith("/repos"))).toHaveLength(1);
  });

  it("leaves a project with no host or no checkout alone for ten minutes", async () => {
    const { feed, calls, clock } = feedFor({
      repos: { Desk: registered("plain", "gone") },
      answers: { Desk: (p) => p === "gone" ? Object.assign(new Error("none"), { status: 404 }) : { available: false, host: { kind: null } } },
    });
    await feed.read();
    clock.t = PULLS_FRESH_MS + 1;
    await feed.read();
    clock.t = PULLS_SKIP_MS - 1;
    await feed.read();
    expect(calls.filter((c) => c.endsWith("/git"))).toHaveLength(2);
    clock.t = PULLS_SKIP_MS + 1;
    await feed.read();
    expect(calls.filter((c) => c.endsWith("/git"))).toHaveLength(4);
  });

  it("asks nothing while hidden, and reports an error only when every read failed", async () => {
    let visible = false;
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
    expect(partly.updates.at(-1)).toMatchObject({ loading: false, failed: false });
    expect((partly.updates.at(-1) as { pulls: unknown[] }).pulls).toHaveLength(1);
  });

  it("does not send a read that was queued when the page was hidden", async () => {
    let visible = true;
    const { feed, calls } = feedFor({ repos: { Desk: registered("a", "b", "c", "d", "e") }, answers: { Desk: () => { visible = false; return open(1); } }, visible: () => visible });
    await feed.read();
    // The two reads in flight finished; the rest never went out.
    expect(calls.filter((c) => c.endsWith("/git")).length).toBeLessThanOrEqual(2);
  });
});
