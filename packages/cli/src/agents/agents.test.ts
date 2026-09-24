/**
 * The agents subsystem discovers coding agents from whatever is already
 * running them and joins them onto phren projects. Records arrive from outside
 * phren and drive a command invocation, so the guard and the failure paths
 * matter as much as the happy one.
 */

import { describe, expect, it, vi } from "vitest";
import { collectAgents, joinAgents, sortAgents } from "./registry.js";
import { isAgentRecord, type AgentProvider, type AgentRecord } from "./types.js";
import { createHerdrProvider, parseHerdrAgents } from "./providers/herdr.js";

/** A real `herdr agent list` envelope, trimmed. */
const HERDR_PAYLOAD = {
  id: "cli:agent:list",
  result: {
    type: "agent_list",
    agents: [
      {
        agent: "claude",
        agent_status: "working",
        cwd: "/home/u/Projects/hub",
        foreground_cwd: "/home/u/Projects/hub",
        focused: false,
        pane_id: "w1G:p1",
        terminal_title: "◑ Hub dev greeting",
        terminal_title_stripped: "Hub dev greeting",
      },
      {
        agent: "claude",
        agent_status: "done",
        cwd: "/home/u/Projects/safety",
        focused: true,
        pane_id: "w1H:p1",
        terminal_title_stripped: "Claude harness upgrade",
      },
    ],
  },
};

function provider(name: string, records: AgentRecord[], available = true): AgentProvider {
  return { name, available: () => available, list: () => records };
}

const record = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "p1", label: "an agent", cwd: "/repo", status: "working", ...over,
});

describe("isAgentRecord", () => {
  it("accepts a well-formed record", () => {
    expect(isAgentRecord(record())).toBe(true);
    expect(isAgentRecord(record({ focus: ["herdr", "agent", "focus", "p1"], kind: "claude", focused: true }))).toBe(true);
  });

  it("rejects anything that could not be rendered or acted on", () => {
    expect(isAgentRecord(null)).toBe(false);
    expect(isAgentRecord([record()])).toBe(false);
    expect(isAgentRecord({ ...record(), id: "" })).toBe(false);
    expect(isAgentRecord({ ...record(), cwd: undefined })).toBe(false);
    expect(isAgentRecord({ ...record(), status: "sleeping" })).toBe(false);
    // A focus command must be usable argv, since it gets executed.
    expect(isAgentRecord({ ...record(), focus: [] })).toBe(false);
    expect(isAgentRecord({ ...record(), focus: "herdr agent focus p1" })).toBe(false);
    expect(isAgentRecord({ ...record(), focus: ["herdr", ""] })).toBe(false);
  });
});

describe("herdr provider", () => {
  it("maps a real envelope onto the contract", () => {
    const agents = parseHerdrAgents(HERDR_PAYLOAD);
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({
      id: "w1G:p1",
      label: "Hub dev greeting",
      cwd: "/home/u/Projects/hub",
      status: "working",
      kind: "claude",
      focused: false,
      focus: ["herdr", "agent", "focus", "w1G:p1"],
    });
    expect(agents[1]).toMatchObject({ status: "done", focused: true, label: "Claude harness upgrade" });
    expect(agents.every((a) => isAgentRecord(a))).toBe(true);
  });

  it("survives shape drift and junk without throwing", () => {
    expect(parseHerdrAgents(null)).toEqual([]);
    expect(parseHerdrAgents({})).toEqual([]);
    expect(parseHerdrAgents({ result: { agents: "nope" } })).toEqual([]);
    // Entries missing the fields we address them by are skipped, not guessed at.
    expect(parseHerdrAgents({ result: { agents: [{ pane_id: "p1" }, { cwd: "/x" }, null, 7] } })).toEqual([]);
  });

  it("prefers the foreground directory, which is what the agent is actually in", () => {
    const agents = parseHerdrAgents({ result: { agents: [{ pane_id: "p1", cwd: "/repo", foreground_cwd: "/repo/packages/cli", agent_status: "working" }] } });
    expect(agents[0].cwd).toBe("/repo/packages/cli");
  });

  it("is unavailable, and never runs, without the binary", () => {
    const runJson = vi.fn();
    const p = createHerdrProvider(() => false, runJson);
    expect(p.available()).toBe(false);
    expect(runJson).not.toHaveBeenCalled();
  });

  it("returns nothing when the command fails rather than throwing", () => {
    const p = createHerdrProvider(() => true, () => null);
    expect(p.list()).toEqual([]);
  });
});

describe("collectAgents", () => {
  it("skips unavailable providers and keeps the first answer for a duplicate id", () => {
    const agents = collectAgents([
      provider("herdr", [record({ id: "a", label: "from herdr" })]),
      provider("offline", [record({ id: "z" })], false),
      provider("other", [record({ id: "a", label: "from other" })]),
    ]);
    expect(agents.map((a) => a.id)).toEqual(["a", "a"]);
    // Same id from two providers is two different agents, so both survive.
    expect(agents.map((a) => a.provider)).toEqual(["herdr", "other"]);
  });

  it("a throwing provider cannot break a repaint", () => {
    const boom: AgentProvider = { name: "boom", available: () => true, list: () => { throw new Error("nope"); } };
    expect(() => collectAgents([boom])).not.toThrow();
    expect(collectAgents([boom, provider("ok", [record()])]).map((a) => a.id)).toEqual(["p1"]);
  });
});

describe("joinAgents", () => {
  it("resolves each directory to a project and caches the lookup", () => {
    const resolve = vi.fn((cwd: string) => (cwd.includes("hub") ? "hub" : null));
    const joined = joinAgents([record({ id: "1", cwd: "/x/hub" }), record({ id: "2", cwd: "/x/hub" }), record({ id: "3", cwd: "/elsewhere" })], resolve);
    expect(joined.map((a) => a.project)).toEqual(["hub", "hub", null]);
    // Two agents in the same directory cost one lookup.
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("keeps an agent whose resolver throws, with no project", () => {
    const joined = joinAgents([record()], () => { throw new Error("bad store"); });
    expect(joined).toHaveLength(1);
    expect(joined[0].project).toBeNull();
  });
});

describe("sortAgents", () => {
  it("puts what you are looking at first, then what is busy", () => {
    const order = sortAgents([
      { ...record({ id: "d", label: "done one", status: "done" }), project: null },
      { ...record({ id: "w", label: "working one", status: "working" }), project: null },
      { ...record({ id: "f", label: "focused one", status: "idle", focused: true }), project: null },
      { ...record({ id: "e", label: "error one", status: "error" }), project: null },
    ]).map((a) => a.id);
    expect(order).toEqual(["f", "w", "e", "d"]);
  });
});
