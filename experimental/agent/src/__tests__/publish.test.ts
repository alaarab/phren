/**
 * The publisher is how phren's graph sees agents this process is running.
 * It writes into someone else's store, so the contract and the cleanup matter
 * more than the happy path.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentPublisher } from "../multi/publish.js";
import type { AgentEntry } from "../multi/types.js";

const entry = (over: Partial<AgentEntry> = {}): AgentEntry => ({
  id: "agent-1", task: "fix the login bug", cwd: "/repo/hub", status: "running", startedAt: Date.now(), ...over,
});

describe("createAgentPublisher", () => {
  let dir: string;
  const read = (pid: number) => JSON.parse(fs.readFileSync(path.join(dir, ".runtime", "agents", `${pid}.json`), "utf8"));

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-publish-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes records in the shape phren's provider reads", () => {
    const p = createAgentPublisher(dir, 4242);
    p.publish([entry(), entry({ id: "agent-2", displayName: "explorer", status: "idle", cwd: "/repo/api" })]);
    const records = read(4242);
    expect(records).toEqual([
      { id: "4242:agent-1", label: "fix the login bug", cwd: "/repo/hub", status: "working", kind: "phren-agent" },
      { id: "4242:agent-2", label: "explorer", cwd: "/repo/api", status: "idle", kind: "phren-agent" },
    ]);
    p.stop();
  });

  it("maps the spawner's statuses onto phren's narrower set", () => {
    const p = createAgentPublisher(dir, 1);
    p.publish([
      entry({ id: "a", status: "starting" }), entry({ id: "b", status: "running" }),
      entry({ id: "c", status: "idle" }), entry({ id: "d", status: "error" }),
      entry({ id: "e", status: "done" }), entry({ id: "f", status: "cancelled" }),
    ]);
    expect(read(1).map((r: { status: string }) => r.status)).toEqual(["working", "working", "idle", "error", "done", "done"]);
    p.stop();
  });

  it("removes its file on stop, so a closed session leaves nothing behind", () => {
    const p = createAgentPublisher(dir, 7);
    p.publish([entry()]);
    const file = path.join(dir, ".runtime", "agents", "7.json");
    expect(fs.existsSync(file)).toBe(true);
    p.stop();
    expect(fs.existsSync(file)).toBe(false);
    // And a publish after stopping is ignored rather than resurrecting it.
    p.publish([entry()]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("is inert without a store, and never throws when the path is unusable", () => {
    expect(() => createAgentPublisher(undefined).publish([entry()])).not.toThrow();
    const p = createAgentPublisher("/proc/nonexistent/nope", 9);
    expect(() => p.publish([entry()])).not.toThrow();
    expect(() => p.stop()).not.toThrow();
  });
});
