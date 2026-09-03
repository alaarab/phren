/**
 * The lookup tail is what makes a graph in one terminal react to an agent
 * working in another, and it is also what the web UI's activity stream reads.
 * It must never throw, never replay old lines, and never hand out a half
 * written record.
 */

import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../test-helpers.js";
import { LookupTail } from "./lookup-tail.js";

describe("LookupTail", () => {
  let tmp: { path: string; cleanup: () => void };
  let logPath: string;
  const append = (line: string) => fs.appendFileSync(logPath, line);
  const event = (query: string) => JSON.stringify({ at: new Date().toISOString(), query, project: "hub", filename: "FINDINGS.md", type: "findings", source: "search" });

  beforeEach(() => {
    tmp = makeTempDir("phren-lookup-tail-");
    logPath = path.join(tmp.path, "lookup-events.jsonl");
  });
  afterEach(() => tmp.cleanup());

  it("yields nothing when the log does not exist yet, then picks it up once written", () => {
    const tail = new LookupTail(logPath);
    expect(tail.poll()).toEqual([]);
    append(event("retry") + "\n");
    expect(tail.poll().map((e) => e.query)).toEqual(["retry"]);
  });

  it("starts at the end so history is not replayed, unless asked", () => {
    append(event("old") + "\n");
    expect(new LookupTail(logPath).poll()).toEqual([]);
    expect(new LookupTail(logPath, { fromEnd: false }).poll().map((e) => e.query)).toEqual(["old"]);
  });

  it("returns each appended event exactly once", () => {
    const tail = new LookupTail(logPath);
    append(event("a") + "\n");
    expect(tail.poll().map((e) => e.query)).toEqual(["a"]);
    expect(tail.poll()).toEqual([]);
    append(event("b") + "\n" + event("c") + "\n");
    expect(tail.poll().map((e) => e.query)).toEqual(["b", "c"]);
    expect(tail.poll()).toEqual([]);
  });

  it("holds a partial line until the writer finishes it", () => {
    const tail = new LookupTail(logPath);
    const line = event("split");
    append(line.slice(0, 20));
    expect(tail.poll()).toEqual([]);
    append(line.slice(20) + "\n");
    expect(tail.poll().map((e) => e.query)).toEqual(["split"]);
  });

  it("recovers when the log is truncated or rotated underneath it", () => {
    const tail = new LookupTail(logPath);
    append(event("before") + "\n");
    tail.poll();
    fs.writeFileSync(logPath, event("after") + "\n");
    expect(tail.poll().map((e) => e.query)).toEqual(["after"]);
  });

  it("skips malformed lines instead of failing the poll", () => {
    const tail = new LookupTail(logPath);
    append("not json\n" + event("good") + "\n{ half\n");
    expect(tail.poll().map((e) => e.query)).toEqual(["good"]);
  });

  it("pollLines hands back the raw JSON the SSE stream forwards verbatim", () => {
    const tail = new LookupTail(logPath);
    const line = event("raw");
    append(line + "\n");
    expect(tail.pollLines()).toEqual([line]);
  });
});
