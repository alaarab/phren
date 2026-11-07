import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";

const engine = vi.hoisted(() => ({ calls: [] as Array<{ project: string; opts: Record<string, unknown> }>, result: { status: "ok", runId: "r1", counts: { applied: 3 } } as Record<string, unknown> }));
vi.mock("../dream/run.js", () => ({
  dream: async (project: string, opts: Record<string, unknown>) => { engine.calls.push({ project, opts }); return engine.result; },
}));

import { parseDreamEvalArgs, parseDreamListArgs, parseDreamRunArgs, readDreamJournal, runDream } from "./dream.js";
import { readLastRun } from "../bridge/dream-schedule.js";

describe("phren dream arguments", () => {
  it("parses run flags", () => {
    expect(parseDreamRunArgs(["--project", "demo", "--dry-run", "--apply", "--force"])).toEqual({ ok: true,
      value: { project: "demo", dryRun: true, mode: "apply", force: true, scheduled: false, json: false } });
    expect(parseDreamRunArgs(["--project=demo", "--propose", "--scheduled", "--json"])).toMatchObject({ ok: true,
      value: { project: "demo", mode: "propose", scheduled: true, json: true } });
    expect(parseDreamRunArgs([])).toMatchObject({ ok: true, value: { dryRun: false, force: false } });
  });

  it("refuses conflicting, unknown or incomplete run flags", () => {
    expect(parseDreamRunArgs(["--apply", "--propose"])).toMatchObject({ ok: false, error: expect.stringMatching(/not both/) });
    expect(parseDreamRunArgs(["--yolo"])).toMatchObject({ ok: false });
    expect(parseDreamRunArgs(["--project"])).toMatchObject({ ok: false, error: expect.stringMatching(/needs a value/) });
    expect(parseDreamRunArgs(["--project", "../etc"])).toMatchObject({ ok: false, error: expect.stringMatching(/Invalid project/) });
  });

  it("parses status and log flags, with --limit only on log", () => {
    expect(parseDreamListArgs(["--project", "demo", "--limit", "5"], "log")).toEqual({ ok: true, value: { project: "demo", limit: 5, json: false } });
    expect(parseDreamListArgs(["--limit=0"], "log")).toMatchObject({ ok: false });
    expect(parseDreamListArgs(["--limit", "5"], "status")).toMatchObject({ ok: false });
    expect(parseDreamListArgs(["--json"], "status")).toEqual({ ok: true, value: { limit: 20, json: true } });
  });

  it("parses eval flags", () => {
    expect(parseDreamEvalArgs(["--real", "--model", "sonnet"])).toEqual({ ok: true, value: { real: true, model: "sonnet", json: false } });
    expect(parseDreamEvalArgs(["--fast"])).toMatchObject({ ok: false });
  });
});

describe("phren dream run and log", () => {
  let store: { path: string; cleanup: () => void };
  beforeEach(() => {
    store = makeTempDir("phren-dream-cli-");
    fs.mkdirSync(path.join(store.path, "demo"));
    engine.calls.length = 0;
  });
  afterEach(() => store.cleanup());

  it("passes trigger to the engine and preserves its newer marker", async () => {
    fs.mkdirSync(path.join(store.path, "demo", "dreams"));
    const file = path.join(store.path, "demo", "dreams", "last-run.json");
    const newer = JSON.stringify({ runId: "newer", at: "2026-11-07T00:00:00Z", to: "2026-11-07T00:00:00Z", status: "ok" });
    fs.writeFileSync(file, newer);
    const outcome = await runDream(store.path, "demo", { mode: "apply", force: true, trigger: "scheduled" });
    expect(engine.calls[0]).toMatchObject({ project: "demo", opts: { mode: "apply", force: true, trigger: "scheduled", phrenPath: store.path } });
    expect(outcome).toMatchObject({ status: "ok", counts: { applied: 3 } });
    expect(fs.readFileSync(file, "utf8")).toBe(newer);
  });

  it("leaves the marker alone for a dry run", async () => {
    await runDream(store.path, "demo", { dryRun: true });
    expect(engine.calls[0].opts).toMatchObject({ dryRun: true });
    expect(readLastRun(store.path, "demo")).toBeUndefined();
  });

  it("reads the journal newest first, skipping headings", () => {
    fs.mkdirSync(path.join(store.path, "demo", "dreams"));
    fs.writeFileSync(path.join(store.path, "demo", "dreams", "journal.md"), "# Dream journal\n\n- r1 first\n- r2 second\n- r3 third\n");
    expect(readDreamJournal(store.path, "demo", 2)).toEqual(["- r3 third", "- r2 second"]);
    expect(readDreamJournal(store.path, "other")).toEqual([]);
  });
});
