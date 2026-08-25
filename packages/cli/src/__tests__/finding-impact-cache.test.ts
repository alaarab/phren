import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";

// Counting wrapper — `vi.spyOn` cannot redefine an ESM namespace property.
// It delegates to the real implementation and only observes.
const { readCounts } = vi.hoisted(() => ({ readCounts: new Map<string, number>() }));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    readFileSync: (target: unknown, ...rest: unknown[]) => {
      if (typeof target === "string") {
        // Split on either separator — Windows paths use "\\", so slicing at the
        // last "/" returned the whole path and nothing was ever counted. Done
        // inline rather than with path.basename: this factory is hoisted above
        // the imports, which is why readCounts goes through vi.hoisted.
        const base = target.split(/[\\/]/).pop() ?? "";
        if (base === "impact.jsonl" || base === "impact-summary.json") {
          readCounts.set(base, (readCounts.get(base) ?? 0) + 1);
        }
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(target, ...rest);
    },
  };
});

const fs = await vi.importActual<typeof import("fs")>("fs");

type ImpactModule = typeof import("../finding/impact.js");

/** A fresh module instance — hook-prompt is a new `node` process every prompt. */
async function freshProcess(): Promise<ImpactModule> {
  vi.resetModules();
  return import("../finding/impact.js");
}

function reads(name: "impact.jsonl" | "impact-summary.json"): number {
  return readCounts.get(name) ?? 0;
}

let tmp: { path: string; cleanup: () => void };
let impact: ImpactModule;

function logFile(): string {
  return path.join(tmp.path, ".runtime", "impact.jsonl");
}

/** Surface a finding `times` times across `times` distinct prompts. */
function surface(mod: ImpactModule, findingId: string, sessionId: string, times: number): void {
  for (let i = 0; i < times; i++) {
    mod.logImpact(tmp.path, [{ findingId, project: "demo", sessionId }]);
  }
}

beforeEach(async () => {
  tmp = makeTempDir("finding-impact-cache-");
  readCounts.clear();
  impact = await freshProcess();
});

afterEach(() => {
  tmp.cleanup();
});

describe("impact aggregate", () => {
  it("does not re-parse the log because a prompt appended to it", async () => {
    surface(impact, "fid:aaaa1111", "s1", 3);
    impact.markImpactEntriesCompletedForSession(tmp.path, "s1");
    readCounts.clear();

    // One prompt: read the aggregate (applyTrustFilter), then append the
    // findings this prompt injected (buildHookOutput).
    expect(impact.getHighImpactFindings(tmp.path, 3)).toEqual(new Set(["fid:aaaa1111"]));
    const afterFirstRead = reads("impact.jsonl");

    impact.logImpact(tmp.path, [{ findingId: "fid:aaaa1111", project: "demo", sessionId: "s2" }]);
    impact.getHighImpactFindings(tmp.path, 3);
    impact.logImpact(tmp.path, [{ findingId: "fid:bbbb2222", project: "demo", sessionId: "s2" }]);
    impact.getHighImpactFindings(tmp.path, 3);

    // The append folds into the aggregate; nothing re-reads the log.
    expect(reads("impact.jsonl")).toBe(afterFirstRead);
  });

  it("hands the aggregate to the next prompt's process instead of the log", async () => {
    surface(impact, "fid:aaaa1111", "s1", 3);
    impact.markImpactEntriesCompletedForSession(tmp.path, "s1");
    impact.getHighImpactFindings(tmp.path, 3);

    // Next prompt, new process: module-level state is gone, only disk remains.
    const next = await freshProcess();
    readCounts.clear();

    expect(next.getHighImpactFindings(tmp.path, 3)).toEqual(new Set(["fid:aaaa1111"]));
    expect(reads("impact.jsonl")).toBe(0);
    expect(reads("impact-summary.json")).toBe(1);
  });

  it("agrees with a from-scratch derive after appends and completions", async () => {
    // Drive the incremental path through a realistic sequence...
    surface(impact, "fid:aaaa1111", "s1", 4);
    surface(impact, "fid:bbbb2222", "s1", 2);
    surface(impact, "fid:cccc3333", "s2", 5);
    impact.markImpactEntriesCompletedForSession(tmp.path, "s1");
    surface(impact, "fid:bbbb2222", "s3", 3);
    impact.markImpactEntriesCompletedForSession(tmp.path, "s3");
    const incremental = impact.getHighImpactFindings(tmp.path, 3);

    // ...then throw the aggregate away and derive it from the log alone.
    fs.rmSync(path.join(tmp.path, ".runtime", "impact-summary.json"), { force: true });
    const scratch = await freshProcess();
    const derived = scratch.getHighImpactFindings(tmp.path, 3);

    // aaaa1111: 4 surfaces, completed in s1. bbbb2222: 5 surfaces, completed in
    // s3. cccc3333: 5 surfaces but never completed.
    expect(incremental).toEqual(new Set(["fid:aaaa1111", "fid:bbbb2222"]));
    expect(incremental).toEqual(derived);
  });

  it("re-derives when another process wrote to the log behind its back", async () => {
    surface(impact, "fid:aaaa1111", "s1", 3);
    impact.markImpactEntriesCompletedForSession(tmp.path, "s1");
    impact.getHighImpactFindings(tmp.path, 3);

    // Something that is not this module appends — the marker must catch it.
    fs.appendFileSync(
      logFile(),
      JSON.stringify({
        findingId: "fid:dddd4444",
        project: "demo",
        timestamp: new Date().toISOString(),
        sessionId: "s9",
        taskCompleted: true,
      }) + "\n"
    );

    const next = await freshProcess();
    readCounts.clear();
    expect(next.getHighImpactFindings(tmp.path, 1)).toEqual(
      new Set(["fid:aaaa1111", "fid:dddd4444"])
    );
    expect(reads("impact.jsonl")).toBe(1);
  });

  it("caps the log and rebuilds the aggregate across the rotation", async () => {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const filler: string[] = [];
    // Track the joined length incrementally — join() in the loop condition is
    // O(n²) and put this test at the CI timeout cliff.
    let joinedLength = 0;
    for (let i = 0; joinedLength < 2_050_000; i++) {
      const line = JSON.stringify({
        findingId: `fid:${(i % 500).toString(16).padStart(8, "0")}`,
        project: "demo",
        timestamp: new Date(1_750_000_000_000 + i * 1000).toISOString(),
        sessionId: `s-${i % 40}`,
        taskCompleted: true,
      });
      filler.push(line);
      joinedLength += line.length + 1;
    }
    fs.writeFileSync(file, filler.join("\n") + "\n");
    expect(fs.statSync(file).size).toBeGreaterThan(2_000_000);

    const before = await freshProcess();
    before.logImpact(tmp.path, [{ findingId: "fid:eeee5555", project: "demo", sessionId: "sz" }]);

    // rotateJsonlIfLarge keeps the tail; the log stops growing.
    expect(fs.statSync(file).size).toBeLessThan(2_000_000);

    // Counts from the discarded prefix must not survive in the aggregate.
    const next = await freshProcess();
    const fromAggregate = next.getHighImpactFindings(tmp.path, 3);
    fs.rmSync(path.join(tmp.path, ".runtime", "impact-summary.json"), { force: true });
    const fromScratch = (await freshProcess()).getHighImpactFindings(tmp.path, 3);
    expect(fromAggregate).toEqual(fromScratch);
  });
});
