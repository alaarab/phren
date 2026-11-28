import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { readTasks, updateTask } from "../data/tasks.js";
import { initializeTaskFormat } from "../data/task-format.js";
import { registeredStoreIdentity } from "../store-registry.js";
import { recordTaskPrs } from "./report-links.js";
import { linksFromContext, parsePrLink } from "./merge-links.js";
import { mergeDecision, reconcileTasks, type PrState } from "./reconcile.js";

const merged: PrState = { number: 7, url: "https://github.com/example/library/pull/7", state: "MERGED", mergedAt: "2026-10-30T12:00:00Z", mergeCommit: { oid: "a".repeat(40) } };
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("private task merge links", () => {
  it("qualifies context references and refuses ambiguous or malformed references", () => {
    expect(linksFromContext("branch: `feat/parser`; example/library#7; https://github.com/example/library/pull/7")).toEqual({ version: 1, branches: [{ repo: "example/library", name: "feat/parser" }], prs: [{ repo: "example/library", number: 7 }] });
    expect(linksFromContext("https://gitlab.com/example/library#7 https://tracker.example/path;example/library#7 https://github.com/example/library/pull/7suffix example/library#7suffix").prs).toEqual([]);
    expect(linksFromContext("branch feat/parser; #7")).toEqual({ version: 1, branches: [], prs: [] });
    expect(linksFromContext("branch feat/parser; example/one#7 example/two#8").branches).toEqual([]);
    expect(linksFromContext("branch example/library@feat/parser").branches).toEqual([{ repo: "example/library", name: "feat/parser" }]);
    expect(linksFromContext("branch `example/library@feat/parser,v2`").branches).toEqual([{ repo: "example/library", name: "feat/parser,v2" }]);
    expect(linksFromContext("branch example/library@feat/parser,v2").branches).toEqual([]);
    expect(linksFromContext("branch example/library@feat/parser+v2").branches).toEqual([{ repo: "example/library", name: "feat/parser+v2" }]);
    expect(linksFromContext(Array.from({ length: 33 }, (_, n) => `example/library#${n + 1}`).join(" ")).prs).toEqual([]);
    expect(linksFromContext("branch feat/parser", "example/library").branches).toEqual([{ repo: "example/library", name: "feat/parser" }]);
    for (const ref of ["#7", "example/library#0", "https://other.example/example/library/pull/7", "https://github.com/example/library/issues/7", "example/library#99999999999999999999"]) expect(parsePrLink(ref)).toBeUndefined();
  });

  it.each([
    { title: "Implement parser", prs: [merged], want: "done" },
    { title: "Implement parser", context: "Acceptance: PR merged", prs: [merged], want: "done" },
    { title: "Implement parser", context: "Acceptance: merge and check the output", prs: [merged], want: "merged, verify" },
    { title: "Implement parser", context: "Acceptance: PR merged; output matches expected", prs: [merged], want: "merged, verify" },
    { title: "Implement parser", context: "Verify on device after deploying", prs: [merged], want: "merged, verify" },
    { title: "Implement parser", prs: [{ ...merged, state: "CLOSED" as const, mergedAt: null, mergeCommit: null }], want: "closed, review" },
    { title: "Implement parser", prs: [merged, { ...merged, state: "OPEN" as const }], want: undefined },
    { title: "Implement parser", prs: [{ ...merged, mergeCommit: null }], want: undefined },
    { title: "Implement parser", prs: [{ ...merged, mergedAt: "invalid" }], want: undefined },
    { title: "Implement parser", prs: [], want: undefined },
  ])("matches $context $prs -> $want", ({ title, context, prs, want }) => {
    expect(mergeDecision({ id: "A1", section: "Active", line: title, checked: false, context }, prs)).toBe(want);
  });

  it("round-trips structured updates, preserves opaque metadata and records dispatch evidence privately", () => {
    const temp = makeTempDir("task-links-");
    try {
      grantAdmin(temp.path);
      initializeTaskFormat(temp.path);
      fs.mkdirSync(path.join(temp.path, "library"));
      fs.writeFileSync(path.join(temp.path, "library", "tasks.md"), '# Tasks\n\n## Active\n\n- [ ] Implement parser <!-- bid:1234abcd -->\n  Future: preserve me\n');
      const task = { storeId: registeredStoreIdentity(temp.path)!, project: "library", stableId: "1234abcd" };
      expect(recordTaskPrs(temp.path, [{ url: merged.url, repo: "example/library", branch: "feat/parser" }], task)).toEqual({ linked: true });
      const result = readTasks(temp.path, "library");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.data.items.Active[0].links).toEqual({ version: 1, branches: [{ repo: "example/library", name: "feat/parser" }], prs: [{ repo: "example/library", number: 7 }] });
      expect(result.data.items.Active[0].opaqueContinuationLines).toEqual(["  Future: preserve me"]);
      expect(updateTask(temp.path, "library", "bid:1234abcd", { links: { ...result.data.items.Active[0].links!, review: "merged, verify", evidence: ["Merged evidence retained"] } }).ok).toBe(true);
      const beforeReport = fs.readFileSync(path.join(temp.path, "library", "tasks.md"), "utf8");
      expect(recordTaskPrs(temp.path, [{ url: merged.url, repo: "example/library", branch: "feat/parser" }], task)).toEqual({ linked: true });
      expect(fs.readFileSync(path.join(temp.path, "library", "tasks.md"), "utf8")).toBe(beforeReport);
      expect(updateTask(temp.path, "library", "bid:1234abcd", { branches: [], prs: [] }).ok).toBe(true);
      expect(recordTaskPrs(temp.path, [{ url: merged.url, repo: "example/other", branch: "feat/parser" }], task).linked).toBe(false);
      const cleared = readTasks(temp.path, "library");
      expect(cleared.ok && cleared.data.items.Active[0].links).toEqual({ version: 1, branches: [], prs: [] });
    } finally { temp.cleanup(); }
  });

  it.skipIf(process.platform === "win32")("reconciles through a fake gh: preview, apply, review gates, caching, retry and offline safety", { timeout: 30_000 }, async () => {
    const temp = makeTempDir("task-reconcile-");
    try {
      grantAdmin(temp.path);
      const project = path.join(temp.path, "library");
      fs.mkdirSync(project);
      const file = path.join(project, "tasks.md");
      const original = `# Tasks

## Active

- [ ] Implement parser <!-- bid:1234abcd -->
  Context: example/library#7
- [ ] Check result <!-- bid:1234abce -->
  Context: example/library#7; Acceptance: merge and check output manually
- [ ] [needs owner] Decide behavior <!-- bid:1234abcf -->
  Context: example/library#7
- [ ] Closed work <!-- bid:1234abd0 -->
  Context: example/library#8
- [ ] Unlinked task <!-- bid:1234abd1 -->
- [ ] A1
  Context: example/library#7
- [ ] Branch work <!-- bid:1234abd2 -->
  Context: branch example/library@feat/other
- [ ] Fork branch <!-- bid:1234abd4 -->
  Context: branch example/library@feat/fork
- [ ] Partially linked branches <!-- bid:1234abd5 -->
  Context: branch \`example/library@feat/other\`; branch example/library@feat/fork
- [ ] Reused branch <!-- bid:1234abd3 -->
  Context: branch example/library@feat/reused

## Queue

## Done
`;
      fs.writeFileSync(file, original);
      const bin = path.join(temp.path, "bin"); fs.mkdirSync(bin);
      const calls = path.join(temp.path, "calls.txt");
      const fixture = path.join(temp.path, "responses"); fs.mkdirSync(fixture);
      const response = (name: string, value: PrState | PrState[]) => fs.writeFileSync(path.join(fixture, `${name}.json`), JSON.stringify(value));
      const other = { ...merged, number: 9, url: merged.url.replace("/7", "/9"), headRefName: "feat/other", headRepository: { nameWithOwner: "example/library" } };
      response("pr-7", merged);
      response("pr-8", { ...merged, number: 8, url: merged.url.replace("/7", "/8"), state: "CLOSED", mergedAt: null, mergeCommit: null });
      response("pr-9", other);
      response("branch-other", [other]);
      response("branch-reused", [merged, other]);
      response("branch-fork", [{ ...merged, headRefName: "feat/fork", headRepository: { nameWithOwner: "someone/library" } }]);
      // Keep real argv transport, exit codes and JSON decoding, without
      // booting 200 Node interpreters just to print fixture responses.
      fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh
printf '%s\\n' "$@" >> "$TEST_GH_CALLS"
[ "$TEST_GH_OFFLINE" = '1' ] && exit 1
case "$1:$2" in
  pr:view) exec cat "$TEST_GH_FIXTURE/pr-$3.json" ;;
  pr:list)
    shift 2
    while [ "$#" -gt 0 ]; do
      if [ "$1" = '--head' ]; then head=$2; break; fi
      shift
    done
    case "$head" in
      feat/other|feat/reused|feat/fork) exec cat "$TEST_GH_FIXTURE/branch-\${head#feat/}.json" ;;
    esac ;;
esac
exit 2
`, { mode: 0o755 });
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
      vi.stubEnv("TEST_GH_CALLS", calls); vi.stubEnv("TEST_GH_FIXTURE", fixture);
      vi.useFakeTimers({ toFake: ["Date"] });
      const preview = await reconcileTasks(temp.path);
      expect(preview).toMatchObject({ dryRun: true, done: 3, review: 2, errors: 0 });
      expect(fs.readFileSync(file, "utf8")).toBe(original);
      const firstCalls = fs.readFileSync(calls, "utf8");
      const applied = await reconcileTasks(temp.path, { apply: true });
      expect(applied).toMatchObject({ dryRun: true, done: 3, review: 2, requests: 0 });
      // tasks retired: apply is refused, so nothing is written and no opt-in is saved.
      expect(fs.readFileSync(file, "utf8")).toBe(original);
      expect(fs.existsSync(path.join(temp.path, ".config", "task-reconcile.json"))).toBe(false);
      const after = fs.readFileSync(file, "utf8");
      expect(await reconcileTasks(temp.path)).toMatchObject({ dryRun: true, done: 3, review: 2, requests: 0 });
      expect(fs.readFileSync(file, "utf8")).toBe(after);
      expect(fs.readFileSync(calls, "utf8")).toBe(firstCalls);
      expect(firstCalls).not.toContain("1234abcd");
      // Expire the cache, then fail gh. No stale positive result may finish work.
      vi.setSystemTime(Date.now() + 20 * 60 * 1000);
      vi.stubEnv("TEST_GH_OFFLINE", "1");
      expect(await reconcileTasks(temp.path)).toMatchObject({ done: 0, review: 0, errors: 1, requests: 1 });
      expect(fs.readFileSync(file, "utf8")).toBe(after);
      expect(await reconcileTasks(temp.path)).toMatchObject({ done: 0, requests: 0 });
      vi.stubEnv("TEST_GH_OFFLINE", "0"); vi.setSystemTime(Date.now() + 20 * 60 * 1000);
      expect(await reconcileTasks(temp.path)).toMatchObject({ done: 3, errors: 0 });
      // A nightly sweep must make progress beyond the same 100 open PRs.
      const lines = [];
      for (let n = 1000; n < 1102; n++) {
        response(`pr-${n}`, { ...merged, number: n, url: merged.url.replace("/7", `/${n}`), state: n === 1101 ? "MERGED" : "OPEN" });
        lines.push(`- [ ] Work ${n} <!-- bid:${n.toString(16).padStart(8, "0")} -->\n  Context: example/library#${n}`);
      }
      fs.writeFileSync(file, `# Tasks\n\n## Active\n\n${lines.join("\n")}\n\n## Done\n`);
      expect(await reconcileTasks(temp.path)).toMatchObject({ requests: 100, done: 0 });
      vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
      expect(await reconcileTasks(temp.path)).toMatchObject({ requests: 100, done: 1 });
      const progressed = readTasks(temp.path, "library");
      expect(progressed.ok && progressed.data.items.Active.map(i => i.line)).toContain("Work 1101");
      expect(progressed.ok && progressed.data.items.Done).toEqual([]);
    } finally { temp.cleanup(); }
  });

  it.skipIf(process.platform === "win32")("never writes after an earlier --apply persisted enabled: true", { timeout: 20_000 }, async () => {
    const temp = makeTempDir("task-reconcile-enabled-");
    try {
      grantAdmin(temp.path);
      const project = path.join(temp.path, "library");
      fs.mkdirSync(project);
      const file = path.join(project, "tasks.md");
      const original = `# Tasks

## Active

- [ ] Implement parser <!-- bid:1234abcd -->
  Context: example/library#7

## Queue

## Done
`;
      fs.writeFileSync(file, original);
      fs.mkdirSync(path.join(temp.path, ".config"), { recursive: true });
      const config = path.join(temp.path, ".config", "task-reconcile.json");
      fs.writeFileSync(config, JSON.stringify({ enabled: true }));
      const bin = path.join(temp.path, "bin"); fs.mkdirSync(bin);
      const fixture = path.join(temp.path, "responses"); fs.mkdirSync(fixture);
      fs.writeFileSync(path.join(fixture, "pr-7.json"), JSON.stringify(merged));
      fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh
case "$1:$2" in
  pr:view) exec cat "$TEST_GH_FIXTURE/pr-$3.json" ;;
esac
exit 2
`, { mode: 0o755 });
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
      vi.stubEnv("TEST_GH_FIXTURE", fixture);

      const summary = await reconcileTasks(temp.path);
      expect(summary).toMatchObject({ dryRun: true, done: 1, review: 0 });
      expect(fs.readFileSync(file, "utf8")).toBe(original);
      expect(JSON.parse(fs.readFileSync(config, "utf8"))).toEqual({ enabled: true });
    } finally { temp.cleanup(); }
  });
});
