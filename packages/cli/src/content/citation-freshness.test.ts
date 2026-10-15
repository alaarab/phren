import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTempDir } from "../test-helpers.js";
import { runtimeFile } from "../phren-paths.js";
import { cachedCitationFreshness, refreshCitationFreshness, type FreshnessCitation } from "./citation-freshness.js";
import { markStaleCitations } from "../shared/retrieval.js";

let tmp: ReturnType<typeof makeTempDir>;
const citation = (file = "src/a.ts", extra = {}): FreshnessCitation => ({ created_at: "2026-10-15T00:00:00Z", file, commit: "abcdef1", projectRemote: "https://gitboy.example/alice/app.git", ...extra });
const response = (url: URL | RequestInfo, changed = false) => {
  const parsed = new URL(String(url));
  return new Response(JSON.stringify({ head: "1234567890", paths: parsed.searchParams.getAll("path").map(file => ({ path: file, changed,
    last_commit: changed ? { sha: "1234567890", summary: "Fix cache", authored_at: "2026-10-15T01:00:00Z" } : null })) }));
};
const options = () => ({ phrenPath: tmp.path, budgetMs: 1500 });
beforeEach(() => { tmp = makeTempDir("citation-freshness-"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); tmp.cleanup(); });

describe("gitboy citation freshness", () => {
  it("groups repositories and commits, deduplicates paths and batches at 100", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => response(url));
    const citations = Array.from({ length: 201 }, (_, i) => citation(`src/${i}.ts`));
    citations.push(citation("src/0.ts"), citation("other.ts", { commit: "abcdef2" }), citation("other.ts", { projectRemote: "git@gitboy.example:bob/app.git" }));
    const result = await refreshCitationFreshness(citations, { ...options(), fetchImpl });
    expect(result.size).toBe(204);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).searchParams.getAll("path").length)).toEqual([100, 100, 1, 1, 1]);
    expect([...result.values()].every(item => item.state === "current")).toBe(true);
  });

  it("normalizes relative and contained absolute paths, rejects traversal and other hosts", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => response(url));
    const repo = path.join(tmp.path, "checkout");
    mkdirSync(repo);
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@gitboy.local:alice/app.git"]);
    const valid = citation(path.join(repo, "src/a.ts"), { repo, projectRemote: "https://github.com/wrong/repo" });
    const inputs = [valid, citation("./src/b.ts"), citation("../escape"), citation("src/../escape"), citation("/outside", { repo }), citation("a\\b"), citation("x", { projectRemote: "https://github.com/a/b" })];
    const result = await refreshCitationFreshness(inputs, { ...options(), fetchImpl });
    expect(result.size).toBe(2);
    expect(fetchImpl.mock.calls.map(([url]) => [new URL(String(url)).host, new URL(String(url)).searchParams.getAll("path")])).toEqual([
      ["gitboy.local", ["src/a.ts"]], ["gitboy.example", ["src/b.ts"]],
    ]);
  });

  it.each([ ["current", 15], ["unknown", 5], ["changed", 60] ] as const)("refreshes %s after its TTL and retains changed evidence on failure", async (state, minutes) => {
    const cite = citation();
    const good = vi.fn(async (url: URL | RequestInfo) => state === "unknown" ? new Response("{}", { status: 503 }) : response(url, state === "changed"));
    await refreshCitationFreshness([cite], { ...options(), fetchImpl: good });
    await refreshCitationFreshness([cite], { ...options(), fetchImpl: good });
    expect(good).toHaveBeenCalledTimes(1);
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now + minutes * 60_000 + 1);
    const failed = vi.fn(async () => new Response("{}", { status: 403 }));
    const result = await refreshCitationFreshness([cite], { ...options(), fetchImpl: failed });
    expect(failed).toHaveBeenCalledTimes(1);
    expect(result.get(cite)?.state).toBe(state === "changed" ? "changed" : "unknown");
    expect(cachedCitationFreshness(cite, options())?.state).toBe(state === "changed" ? "changed" : "unknown");
    if (state === "changed") {
      vi.setSystemTime(now + 7 * 86400_000 + 1);
      expect(cachedCitationFreshness(cite, options())).toBeUndefined();
    }
  });

  it("evicts the oldest entries beyond 5000", async () => {
    const file = runtimeFile(tmp.path, "citation-freshness.json");
    const entries = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`old-${i}`, { state: "current", checkedAt: new Date(Date.now() - 5000 + i).toISOString() }]));
    writeFileSync(file, JSON.stringify(entries));
    await refreshCitationFreshness([citation()], { ...options(), fetchImpl: async url => response(url) });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(saved)).toHaveLength(5000);
    expect(saved["old-0"]).toBeUndefined();
    expect(cachedCitationFreshness(citation(), options())).toMatchObject({ state: "current", checkedAt: expect.any(String) });
  });

  it("bounds a hung fetch, aborts it and returns unknown without throwing", async () => {
    const cite = citation();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url, init) => { signal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); }) as unknown as typeof fetch;
    const result = await refreshCitationFreshness([cite], { ...options(), budgetMs: 40, fetchImpl });
    expect(result.get(cite)?.state).toBe("unknown");
    expect(signal?.aborted).toBe(true);
  });

  it("does no network with no budget, an aborted caller, or the off switch", async () => {
    const cite = citation();
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => response(url));
    expect((await refreshCitationFreshness([cite], { ...options(), budgetMs: 0, fetchImpl })).get(cite)?.state).toBe("unknown");
    await refreshCitationFreshness([citation("b.ts")], { ...options(), signal: AbortSignal.abort(), fetchImpl });
    vi.stubEnv("PHREN_CITATION_FRESHNESS", "off");
    expect((await refreshCitationFreshness([cite], { ...options(), fetchImpl })).size).toBe(0);
    expect(cachedCitationFreshness(cite, options())).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("deduplicates overlapping polls and persists a cache other callers can read", async () => {
    const cite = citation();
    let release!: (value: Response) => void;
    const fetchImpl = vi.fn(async () => await new Promise<Response>(resolve => { release = resolve; }));
    const first = refreshCitationFreshness([cite], { ...options(), fetchImpl });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await refreshCitationFreshness([cite], { ...options(), fetchImpl });
    release(response(new URL("https://gitboy.example/?path=src/a.ts"), true));
    await first;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cachedCitationFreshness(cite, options())).toMatchObject({ state: "changed", head: "1234567890", lastCommit: { sha: "1234567890", summary: "Fix cache" } });
  });

  it("annotates finding lines from cache, including the detail-free fallback, without network", async () => {
    const cite = citation();
    await refreshCitationFreshness([cite], { ...options(), fetchImpl: async url => response(url, true) });
    const snippet = `- Cache avoids double charges\n  <!-- phren:cite ${JSON.stringify(cite)} -->`;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
    expect(markStaleCitations(snippet, { ...options(), projectRemote: cite.projectRemote })).toContain('- Cache avoids double charges [may be out of date: src/a.ts changed in 1234567 "Fix cache"]');
    const file = runtimeFile(tmp.path, "citation-freshness.json");
    const entries = JSON.parse(readFileSync(file, "utf8"));
    Object.values(entries).forEach(value => { (value as { lastCommit: null }).lastCommit = null; });
    writeFileSync(file, JSON.stringify(entries));
    expect(markStaleCitations(snippet, { ...options(), projectRemote: cite.projectRemote })).toContain("[may be out of date: src/a.ts changed since cited]");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
