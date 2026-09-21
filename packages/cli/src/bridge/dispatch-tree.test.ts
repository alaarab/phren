import { describe, expect, it, vi } from "vitest";
import { remoteChildren, validateDispatchParent, type DispatchParent, type DispatchTreeReceipt } from "./dispatch-tree.js";
import { childAgent, publicChildAgents } from "./transcripts.js";

const parent: DispatchParent = {
  provider: "codex",
  session: "aaaaaaaa-1111-4111-8111-111111111111",
  computer: "10000000-0000-4000-8000-000000000001",
};
const parentTarget = {
  server: "default", workspace: "parent-workspace", tab: "parent-tab", pane: "parent-pane",
  source: "codex" as const, session: parent.session,
};

const remoteTarget = (session = "bbbbbbbb-2222-4222-8222-222222222222", pane = "remote-pane") => ({
  server: "default", workspace: "remote-workspace", tab: "remote-tab", pane,
  source: "codex" as const, session,
});

function receipt(overrides: Partial<DispatchTreeReceipt> = {}): DispatchTreeReceipt {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    computer: "Linuxbox",
    computerId: "30000000-0000-4000-8000-000000000001",
    label: "Parser checks",
    model: "configured-model",
    state: "accepted",
    target: remoteTarget(),
    parent,
    parentTarget,
    ...overrides,
  };
}

type AgentFixture = {
  id: string; provider: string; path: string; callId: string; state: string; children: AgentFixture[];
  [key: string]: unknown;
};

function agent(id: string, overrides: Record<string, unknown> = {}): AgentFixture {
  return { id, provider: "codex", path: `Task ${id.slice(0, 4)}`, callId: `call:${id.slice(0, 4)}`,
    state: "running", children: [], ...overrides } as AgentFixture;
}

describe("dispatch parent admission", () => {
  it("requires the local computer and exact live target", async () => {
    const validate = vi.fn(async () => ({}));
    await expect(validateDispatchParent({ parent, parentTarget }, parent.computer, validate))
      .resolves.toEqual({ parent, parentTarget });
    expect(validate).toHaveBeenCalledWith(parentTarget);

    await expect(validateDispatchParent({ parent: { ...parent, computer: "40000000-0000-4000-8000-000000000001" }, parentTarget },
      parent.computer, validate)).rejects.toMatchObject({ status: 403 });
    await expect(validateDispatchParent({ parent, parentTarget: { ...parentTarget, session: "cccccccc-3333-4333-8333-333333333333" } },
      parent.computer, validate)).rejects.toMatchObject({ status: 400 });
    await expect(validateDispatchParent({ parent }, parent.computer, validate)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a parent target replaced after identity validation begins", async () => {
    const validate = vi.fn(async () => { throw Object.assign(new Error("conversation changed"), { status: 409 }); });
    await expect(validateDispatchParent({ parent, parentTarget }, parent.computer, validate)).rejects.toMatchObject({ status: 409 });
  });
});

describe("remote ancestry projection", () => {
  it("keeps equal session IDs on different computers distinct", async () => {
    const second = receipt({
      id: "20000000-0000-4000-8000-000000000002",
      computer: "Desk",
      computerId: "30000000-0000-4000-8000-000000000002",
    });
    const tree = await remoteChildren(parent, [receipt(), second], new Map([
      [receipt().id, { agents: [] }], [second.id, { agents: [] }],
    ]));
    expect(tree).toHaveLength(2);
    expect(new Set(tree.map(row => row.id)).size).toBe(2);
    expect(tree.map(row => row.computer?.id)).toEqual([
      "30000000-0000-4000-8000-000000000001",
      "30000000-0000-4000-8000-000000000002",
    ]);
  });

  it("keeps an offline and a completed lead visible", async () => {
    const completed = receipt({ id: "20000000-0000-4000-8000-000000000002", state: "completed",
      target: remoteTarget("cccccccc-3333-4333-8333-333333333333") });
    const tree = await remoteChildren(parent, [receipt(), completed], new Map());
    expect(tree.map(row => row.state)).toEqual(["unavailable", "completed"]);
    expect(tree.every(row => row.children.length === 0)).toBe(true);
  });

  it("rejects a replaced remote parent target and its descendants", async () => {
    const current = receipt();
    const tree = await remoteChildren(parent, [current], {
      [current.id]: { target: remoteTarget(undefined, "replacement-pane"), agents: [agent("a".repeat(32))] },
    });
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ state: "unavailable", children: [] });
    expect(tree[0].remote?.target).toEqual(current.target);
  });

  it("keeps local fan-outs nested under the remote lead and preserves deeper remote routing", async () => {
    const current = receipt(), thirdTarget = {
      server: "other", workspace: "w3", tab: "t3", pane: "p3", source: "opencode" as const,
      session: "ses_nested3",
    };
    const privatePath = "/home/sam/private/worktree";
    const tree = await remoteChildren(parent, [current], {
      [current.id]: { agents: [agent("a".repeat(32), { path: privatePath, cwd: privatePath, transcript: `${privatePath}/events.jsonl`, children: [
        agent("b".repeat(32), { provider: "opencode", computer: {
          id: "50000000-0000-4000-8000-000000000001", name: "Buildbox",
        }, remote: { target: thirdTarget, child: "c".repeat(32) } }),
      ] })] },
    });
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0]).toMatchObject({
      path: "Agent",
      computer: { id: current.computerId, name: current.computer },
      remote: { target: current.target, child: "a".repeat(32) },
    });
    expect(tree[0].children[0].children[0]).toMatchObject({
      computer: { id: "50000000-0000-4000-8000-000000000001", name: "Buildbox" },
      remote: { target: thirdTarget, child: "c".repeat(32) },
    });
    const wire = publicChildAgents(tree);
    expect(JSON.stringify(wire)).not.toContain(privatePath);
    expect(wire[0]).not.toHaveProperty("session");
    expect(wire[0]).not.toHaveProperty("transcript");
  });

  it("bounds cycles, depth, and the total projected node count", async () => {
    const current = receipt();
    const chain = agent("1".repeat(32));
    let cursor = chain;
    for (const value of ["2", "3", "4", "5", "6"]) {
      const next = agent(value.repeat(32)); cursor.children = [next]; cursor = next;
    }
    const cycle = agent("d".repeat(32), {
      computer: { id: parent.computer, name: "Desk" },
      remote: { target: parentTarget },
    });
    const many = Array.from({ length: 200 }, (_, index) => agent(index.toString(16).padStart(32, "0")));
    const tree = await remoteChildren(parent, [current], { [current.id]: { agents: [chain, cycle, ...many] } });
    const flatten = (rows: typeof tree): typeof tree => rows.flatMap(row => [row, ...flatten(row.children)]);
    const rows = flatten(tree);
    expect(rows).toHaveLength(128);
    expect(rows.some(row => row.remote?.target.session === parent.session)).toBe(false);
    expect(tree[0].children[0].children[0].children[0].children).toEqual([]);
  });

  it("does not let local-child routes resolve a remote lead or descendant", async () => {
    const current = receipt();
    const tree = await remoteChildren(parent, [current], { [current.id]: { agents: [agent("a".repeat(32))] } });
    expect(childAgent(tree, tree[0].id)).toBeUndefined();
    expect(childAgent(tree, tree[0].children[0].id)).toBeUndefined();
  });

  it("ignores receipts with a spoofed parent identity", async () => {
    const spoofed = receipt({ parent: { ...parent, computer: "60000000-0000-4000-8000-000000000001" } });
    expect(await remoteChildren(parent, [spoofed], { [spoofed.id]: { agents: [] } })).toEqual([]);
  });
});
