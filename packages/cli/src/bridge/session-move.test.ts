import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as protocol from "./protocol.js";
import { clearConductor, conductorPane, noteConductorSession, recordConductor, recordedConductor, resetRoleState } from "./conductor-role.js";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { capabilitiesForModules } from "./server-routes.js";
import { dispatchStatus, type Receipt } from "./dispatch.js";
import { DispatchReturns, observe, workerStates } from "./dispatch-returns.js";
import type { HarnessInventory } from "./harnesses.js";
import type { Json, Target } from "./protocol.js";
import { listMoves, moveSessionFields, readMove, SessionMover, type MoverDeps, type MoveRecord } from "./session-move.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-move-")); vi.stubEnv("PHREN_BRIDGE_HOME", root); });
afterEach(async () => { vi.restoreAllMocks(); resetRoleState(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

const SESSION = "00000003-1111-4111-8111-111111111111";
const NEXT = "00000004-2222-4222-8222-222222222222";
const DISPATCH = "40000000-0000-4000-8000-000000000001";
const from: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude", session: SESSION };

const inventory: HarnessInventory = { harnesses: [
  { source: "claude", installed: true, usable: true, accounts: [
    { id: "default", label: "Claude", key: "claude:a", signedIn: true, usable: true },
    { id: "work", label: "Work", key: "claude:b", signedIn: true, usable: true },
    { id: "spare", label: "Spare", key: "claude:c", signedIn: false, usable: false, reason: "Not signed in" }] },
  { source: "codex", installed: true, usable: true, accounts: [{ id: "default", label: "Codex", key: "codex", signedIn: true, usable: true }] },
  { source: "opencode", installed: false, usable: false, reason: "Not installed" },
] } as HarnessInventory;

const user = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const agent = (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

/** One Herdr pane running Claude, whose agent answers prompts the way `reply` says. */
function world(options: { reply?: (request: string) => string | undefined; exits?: boolean; tmux?: boolean } = {}) {
  const pane: Json = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "claude", agent_status: "idle", cwd: "/work/repo", terminal_id: "term-1", label: "parser fix" };
  const panes: Json[] = [pane];
  const transcript = [user("Fix the parser and open a PR"), agent("Working on it: edited src/parser.ts, tests next."),
    // A hand-off from an earlier move of this conversation, which never counts again.
    agent("=== PHREN HANDOFF deadbeef BEGIN ===\nold\n=== PHREN HANDOFF deadbeef END ===")];
  const typed: string[] = [], keys: string[][] = [], launches: { data: Json; options: Json }[] = [], killed: string[] = [], closed: string[] = [];
  let session: string | undefined = SESSION;
  const deps: MoverDeps = {
    snapshot: async () => ({ panes: panes.map(item => ({ ...item })) }),
    identity: async () => session,
    terminal: {
      prompt: async (_server, _pane, text) => {
        typed.push(text);
        if (text === "/exit" && options.exits !== false) { delete pane.agent; session = undefined; }
      },
      sendKeys: async (_server, _pane, sent) => { keys.push(sent); },
      processes: async () => ({ shellPid: 10, foregroundPids: [10, 11] }),
      closePane: async (_server, id) => { closed.push(id); },
    },
    deliver: async (_target, text) => {
      typed.push(text);
      transcript.push(user(text));
      const reply = options.reply?.(text);
      if (reply) transcript.push(agent(reply));
      return { ok: true, delivered: true };
    },
    launch: async (_server, data, launchOptions) => {
      launches.push({ data, options: launchOptions as Json });
      const into = launchOptions.into;
      const place = into ?? { workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2" };
      if (!into) panes.push({ pane_id: place.paneId, tab_id: place.tabId, workspace_id: place.workspaceId, agent: data.kind, agent_status: "idle", terminal_id: "term-2" });
      else pane.agent = data.kind;
      return { ok: true, ...place, briefLaunched: true, target: { server: "default", workspace: place.workspaceId, tab: place.tabId, pane: place.paneId, source: data.kind, session: NEXT } };
    },
    inventory: async () => inventory,
    transcript: async () => transcript,
    git: async () => ({ root: "/work/repo", branch: "fix/parser", head: "abc123 Start parser fix", changes: [" M src/parser.ts", "?? src/parser.test.ts"] }),
    processesBelow: async () => ["12 pnpm dev"],
    paneAccount: () => "default",
    paneDispatch: async () => DISPATCH,
    brief: async id => id === DISPATCH ? "Original brief: fix the parser, open a PR, do not merge." : undefined,
    isConductor: async (server, candidate) => (await conductorPane(server, { panes }))?.pane_id === candidate.pane_id,
    envAtStart: () => options.tmux === true,
    kill: (pid, signal) => { killed.push(`${signal} ${pid}`); if (signal === "SIGKILL") delete pane.agent; },
    sleep: async () => {},
    pollMs: 1,
    exitMs: 1,
  };
  // The fake clock moves a second per read, so waits end without real time passing.
  let clock = Date.parse("2026-10-10T12:00:00Z");
  deps.now = () => (clock += 1_000);
  return { deps, pane, panes, typed, keys, launches, killed, closed };
}

async function move(deps: MoverDeps, to: Json, extra: Json = {}): Promise<MoveRecord> {
  const mover = new SessionMover(deps);
  const started = await mover.start({ target: from, to, ...extra });
  await mover.settled(from.server, from.pane);
  return (await readMove(started.id))!;
}

async function seedReceipt(overrides: Partial<Receipt> = {}): Promise<void> {
  await mkdir(path.join(root, "dispatches"), { recursive: true });
  const at = new Date().toISOString();
  await writeFile(path.join(root, "dispatches", `${overrides.id ?? DISPATCH}.json`), JSON.stringify({
    id: DISPATCH, computer: "local", project: "phren", harness: "claude", label: "existing worker",
    createdAt: at, updatedAt: at, state: "accepted",
    target: { ...from, pane: "w1:p8" },
    origin: { server: from.server, workspace: from.workspace, tab: from.tab, pane: from.pane, agent: "claude", terminal: "term-1" },
    returned: { state: "needs-you", at, read: false, notifiedAt: at },
    approval: { actionId: "act-1", tool: "Bash", at }, ...overrides,
  }));
}

const writes = (request: string) => {
  const marker = /=== PHREN HANDOFF (\w+) BEGIN ===/.exec(request)?.[1];
  return marker ? `\`\`\`\n=== PHREN HANDOFF ${marker} BEGIN ===\n## Goal\nFix the parser.\n## Next steps\nRun the tests.\n=== PHREN HANDOFF ${marker} END ===\n\`\`\`` : undefined;
};

describe("moving a session to another agent", () => {
  it.each([
    ["replace", "codex", "adjacent-pane"],
    ["replace", "claude", "adjacent-pane"],
    ["new-chat", "codex", "adjacent-pane"],
  ])("moves the conductor with its role (%s to %s, %s)", async (mode, harness, placement) => {
    const { deps, pane, panes, typed, keys, killed, closed } = world({ reply: writes });
    await recordConductor(from.server, pane, "owner", SESSION);
    const launch = deps.launch;
    deps.launch = async (...args) => {
      expect(await recordedConductor()).toMatchObject({ pane: from.pane, session: SESSION });
      return launch(...args);
    };
    const record = await move(deps, { harness, ...(harness === "claude" ? { account: "work" } : {}) }, { mode });
    expect(record).toMatchObject({ state: "moved", mode: "new-chat", modeForced: "conductor", placement, target: { session: NEXT } });
    expect(record.exit).toBeUndefined();
    expect(pane.agent).toBe("claude");
    expect(typed).toHaveLength(1);
    expect([keys, killed, closed]).toEqual([[], [], []]);
    expect(record.handedOffTo).toEqual({ target: record.target });
    expect(record.handedOffFrom?.target).toEqual(from);
    resetRoleState(); // Verify the role persisted, rather than just the cached state.
    expect(await recordedConductor()).toMatchObject({ server: from.server, pane: record.target!.pane, source: harness, session: NEXT });
    expect((await conductorPane(from.server, { panes }))?.pane_id).toBe(record.target!.pane);
    expect(await readFile(record.handoff!.path, "utf8")).toContain("You are now the conductor");
    expect(closed).toEqual([]);
    const modules = { modules: BUILTIN_MODULES, has: () => true };
    expect(capabilitiesForModules(modules as never).moveConductor).toBe(true);
  });

  it.each(["replace", "new-chat"])("keeps the old conductor and reports a role-transfer failure (%s)", async mode => {
    const { deps, pane, closed } = world({ reply: writes });
    await recordConductor(from.server, pane, "owner", SESSION);
    const old = await recordedConductor();
    const launch = deps.launch;
    deps.launch = async (...args) => {
      const launched = await launch(...args);
      vi.spyOn(protocol, "atomicInPrivateDir").mockRejectedValueOnce(new Error("role disk full"));
      return launched;
    };
    const record = await move(deps, { harness: "claude", account: "work" }, { mode });
    expect(record).toMatchObject({ state: "failed", error: expect.stringContaining("Conductor role transfer failed") });
    expect(record.error).toContain("role disk full");
    expect(record.error).not.toContain("old agent has exited");
    expect(pane.agent).toBe("claude");
    expect(record.movedAt).toBeUndefined();
    resetRoleState();
    expect(await recordedConductor()).toEqual(old);
    expect(closed).toEqual([]);
  });

  it.each(["launch", "receipt", "role"])("keeps the old conductor running when %s fails", async failure => {
    const { deps, pane, typed, closed } = world({ reply: writes });
    await recordConductor(from.server, pane, "owner", SESSION);
    await seedReceipt();
    await seedReceipt({ id: "40000000-0000-4000-8000-000000000002" });
    const launch = deps.launch;
    deps.launch = async (...args) => {
      if (failure === "launch") throw new Error("launch refused");
      const result = await launch(...args);
      if (failure === "role") vi.spyOn(protocol, "atomicInPrivateDir").mockRejectedValueOnce(new Error("role disk full"));
      if (failure === "receipt") {
        const atomic = protocol.atomic;
        let changes = 0;
        vi.spyOn(protocol, "atomic").mockImplementation(async (file, ...rest) => {
          if (file.includes("dispatches") && ++changes === 2) throw new Error("receipt disk full");
          return atomic(file, ...rest);
        });
      }
      return result;
    };
    const record = await move(deps, { harness: "codex" });
    expect(record.state).toBe("failed");
    expect(pane.agent).toBe("claude");
    expect(typed).toHaveLength(1);
    expect(closed).toEqual([]);
    resetRoleState();
    expect(await recordedConductor()).toMatchObject({ pane: from.pane, session: SESSION });
    const receipts = await dispatchStatus();
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt.origin).toMatchObject({ pane: from.pane, terminal: "term-1" });
      expect(receipt.returned?.notifiedAt).toBeDefined();
    }
  });

  it.each(["stop", "reassign", "session"])("refuses a stale conductor hand-over after a %s during launch", async change => {
    const { deps, pane } = world({ reply: writes });
    await recordConductor(from.server, pane, "owner", SESSION);
    await seedReceipt();
    const launch = deps.launch;
    deps.launch = async (...args) => {
      const result = await launch(...args);
      if (change === "stop") await clearConductor();
      if (change === "reassign") await recordConductor(from.server, { ...pane, pane_id: "w1:p9" }, "owner", "other-session");
      if (change === "session") await noteConductorSession(from.server, from.pane, "other-session");
      return result;
    };
    const record = await move(deps, { harness: "codex" });
    expect(record).toMatchObject({ state: "failed", error: "The conductor changed during the move; nothing was transferred." });
    expect(pane.agent).toBe("claude");
    expect((await dispatchStatus())[0].origin?.pane).toBe(from.pane);
    const held = await recordedConductor();
    if (change === "stop") expect(held).toBeUndefined();
    else expect(held).toMatchObject(change === "session" ? { pane: from.pane, session: "other-session" } : { pane: "w1:p9" });
  });

  it("routes existing worker returns and approvals to the new conductor", async () => {
    const { deps, pane, panes } = world({ reply: writes });
    await recordConductor(from.server, pane, "owner", SESSION);
    await seedReceipt();
    const record = await move(deps, { harness: "codex" });
    const [receipt] = await dispatchStatus();
    expect(receipt.origin).toEqual({ server: "default", workspace: "w1", tab: "w1:t2", pane: "w1:p2", agent: "codex", terminal: "term-2" });
    const deliver = vi.fn(async () => ({ delivered: true }));
    const answer = vi.fn(async () => {});
    const returns = new DispatchReturns({ peers: async () => [], isLocal: () => true, localAnswer: answer,
      snapshot: async () => ({ panes }), identity: async () => NEXT, deliver,
      localWorkers: async () => ({ workers: [] }) });
    await expect(returns.answerApproval(DISPATCH, "approve", "act-1", from)).rejects.toMatchObject({ status: 403 });
    await returns.answerApproval(DISPATCH, "approve", "act-1", record.target as Target);
    expect(answer).toHaveBeenCalledTimes(1);
    await returns.tick();
    expect(deliver).toHaveBeenCalledWith(record.target, expect.stringContaining("Return:"), expect.any(String));
  });

  it("leaves unrelated and closed receipt origins alone and refuses an in-flight dispatch", async () => {
    const { deps, pane } = world({ reply: writes });
    await recordConductor(from.server, pane, "owner", SESSION);
    await seedReceipt({ state: "launching" });
    const refused = await move(deps, { harness: "codex" });
    expect(refused).toMatchObject({ state: "failed", error: expect.stringContaining("dispatch is still being placed") });
    expect(await recordedConductor()).toMatchObject({ pane: from.pane });
    await seedReceipt({ closedAt: new Date().toISOString() });
    await seedReceipt({ id: "40000000-0000-4000-8000-000000000002", origin: {
      server: from.server, workspace: from.workspace, tab: from.tab, pane: "w1:p9", agent: "claude", terminal: "term-9",
    } });
    const moved = await move(deps, { harness: "codex" });
    expect(moved.state).toBe("moved");
    expect((await dispatchStatus()).map(receipt => receipt.origin?.pane).sort()).toEqual([from.pane, "w1:p9"]);
    expect(pane.agent).toBe("claude");
  });

  it.each([false, true])("reports moved with a warning when status saving fails after role transfer (persistent %s)", async persistent => {
    const { deps, pane } = world({ reply: writes });
    await recordConductor(from.server, pane, "owner", SESSION);
    await seedReceipt();
    const atomic = protocol.atomic;
    vi.spyOn(protocol, "atomic").mockImplementation(async (file, value, ...rest) => {
      if (file.includes("moves") && typeof value === "object" && object(value).state === "moved") {
        if (persistent || !object(value).notice) throw new Error("move status disk full");
      }
      return atomic(file, value, ...rest);
    });
    const record = await move(deps, { harness: "codex" });
    expect(record).toMatchObject({ state: "moved", notice: expect.stringContaining("move status disk full"), target: { pane: "w1:p2" } });
    expect(record.error).toBeUndefined();
    expect(await recordedConductor()).toMatchObject({ pane: "w1:p2", session: NEXT });
    expect((await dispatchStatus())[0].origin?.pane).toBe("w1:p2");
    expect((await listMoves(Date.parse(record.updatedAt)))[0].state).toBe("moved");
    expect(pane.agent).toBe("claude");
  });

  it("keeps an unrelated conductor when a worker moves", async () => {
    const { deps, panes } = world({ reply: writes });
    const conductor = { ...panes[0], pane_id: "w1:p9", terminal_id: "term-9" };
    panes.push(conductor);
    await recordConductor(from.server, conductor, "owner", "other-session");
    const old = await recordedConductor();
    expect(await move(deps, { harness: "codex" })).toMatchObject({ state: "moved" });
    resetRoleState();
    expect(await recordedConductor()).toEqual(old);
  });

  it.each([undefined, "replace"])("saves the hand-off and replaces the agent in place (mode %s)", async mode => {
    const { deps, typed, launches, closed } = world({ reply: writes });
    const record = await move(deps, { harness: "codex", model: "gpt-5.5", effort: "high" }, mode ? { mode } : {});

    expect(record).toMatchObject({ state: "moved", placement: "same-pane", exit: "clean", dispatch: DISPATCH,
      handoff: { source: "agent" }, target: { pane: "w1:p1", source: "codex", session: NEXT } });
    // The hand-off is asked for, then the agent's own exit command is typed: nothing is killed or committed.
    expect(typed[0]).toContain("Do not commit, stash, reset");
    expect(typed.slice(1)).toEqual(["/exit"]);
    const handoff = await readFile(record.handoff!.path, "utf8");
    expect(handoff).toContain("## Goal\nFix the parser.");
    expect(handoff).not.toContain("old");
    expect(handoff).toContain(" M src/parser.ts\n?? src/parser.test.ts");
    expect(handoff).toContain("12 pnpm dev");
    expect(launches).toHaveLength(1);
    expect(launches[0].options).toEqual({ into: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" }, dispatchId: DISPATCH });
    expect(launches[0].data).toMatchObject({ kind: "codex", model: "gpt-5.5", effort: "high", cwd: "/work/repo" });
    // The first prompt is the whole hand-off plus the instruction to continue.
    expect(String(object(launches[0].data.brief).text)).toMatch(/Continue from here[\s\S]*## Goal\nFix the parser\./);
    expect(closed).toEqual([]);
  });

  it.each([
    ["codex", true], ["codex", false], ["opencode", true], ["copilot", true],
  ] as const)("new-chat preserves the old agent and links both chats (%s, agent reply %s)", async (harness, replies) => {
    const { deps, pane, typed, keys, killed, closed, launches } = world({ reply: replies ? writes : undefined });
    const afterExit = vi.fn();
    deps.afterExit = afterExit;
    deps.inventory = async () => undefined;
    const launch = deps.launch;
    deps.launch = async (...args) => ({ ...await launch(...args), briefLaunched: harness !== "copilot" });
    const record = await move(deps, { harness, model: "target-model" }, { mode: "new-chat", handoffTimeoutMs: 5_000 });
    expect(record).toMatchObject({ state: "moved", mode: "new-chat", placement: "adjacent-pane",
      handoff: { source: replies ? "agent" : "fallback" },
      target: { pane: "w1:p2", session: NEXT, source: harness },
      handedOffFrom: { target: from, title: "parser fix" } });
    expect(record.handedOffTo).toEqual({ target: record.target });
    expect(record.exit).toBeUndefined();
    expect(pane.agent).toBe("claude");
    expect(typed).toHaveLength(harness === "copilot" ? 2 : 1);
    expect(typed[0]).toContain("Keep this agent running");
    expect([keys, killed, closed]).toEqual([[], [], []]);
    expect(afterExit).not.toHaveBeenCalled();
    expect(launches).toHaveLength(1);
    expect(launches[0].options.into).toBeUndefined();
    expect(launches[0].data).toMatchObject({ kind: harness, cwd: "/work/repo", workspaceId: "w1" });
    const prompt = String(object(launches[0].data.brief).text);
    if (harness === "copilot") expect(typed[1]).toBe(prompt);
    for (const text of ["## Goal", "Fix the parser", "fix/parser", "src/parser.ts", "## Next steps", "parser fix", JSON.stringify(from)]) {
      expect(prompt).toContain(text);
    }
    const records = await listMoves(Date.parse(record.updatedAt));
    expect(moveSessionFields(records, from, "parser fix")).toEqual({ title: `parser fix (handed off to ${harness})`, handedOffTo: { target: record.target } });
    expect(moveSessionFields(records, record.target as Target)).toEqual({ handedOffFrom: { target: from, title: "parser fix" } });
    expect(moveSessionFields(records, { ...from, session: NEXT })).toEqual({});
    expect(await readFile(path.join(path.dirname(record.handoff!.path), "brief.md"), "utf8")).toContain(prompt);
  });

  it.each(["throw", "refused", "failed-state", "undelivered", "terminal-throw"])("fails a new-chat move when first-prompt delivery fails (%s)", async failure => {
    const { deps, pane, panes, closed } = world({ reply: writes });
    const launch = deps.launch;
    deps.launch = async (...args) => {
      const result: Json = { ...await launch(...args), briefLaunched: false };
      if (failure === "terminal-throw") delete result.target;
      return result;
    };
    const deliver = deps.deliver;
    deps.deliver = async (target, ...args) => {
      if (target.pane === from.pane) return deliver(target, ...args);
      if (failure === "throw") throw new Error("startup screen");
      return failure === "failed-state" ? { ok: true, state: "failed", error: "submission refused" }
        : failure === "undelivered" ? { ok: true, delivered: false, error: "submission refused" }
        : { ok: false, error: "submission refused" };
    };
    deps.terminal.prompt = async () => { throw new Error("startup screen"); };
    const record = await move(deps, { harness: "codex" }, { mode: "new-chat" });
    expect(record).toMatchObject({ state: "failed", error: expect.stringContaining("New chat started but did not receive the hand-off") });
    expect(record.error).toContain(failure === "throw" || failure === "terminal-throw" ? "startup screen" : "submission refused");
    expect(pane.agent).toBe("claude");
    expect(panes.find(item => item.pane_id === "w1:p2")?.agent).toBe("codex");
    expect(closed).toEqual([]);
    expect(record.paneTarget).toEqual({ server: "default", workspace: "w1", tab: "w1:t2", pane: "w1:p2", source: "codex" });
    expect(record.handedOffTo).toBeUndefined();
    expect(moveSessionFields([record], from)).toEqual({});
  });

  it.each([[45_000, true], [Infinity, true], [Infinity, false]] as const)("keeps linking a slow new chat until identity or the bounded deadline (%s ms, starting target %s)", async (delay, hasStartingTarget) => {
    const { deps, pane, closed } = world({ reply: writes });
    let now = Date.parse("2026-10-14T12:00:00Z"), launchedAt = 0;
    const launch = deps.launch;
    deps.launch = async (...args) => {
      const result = await launch(...args);
      launchedAt = now;
      const target: Json = { ...object(result.target), starting: true, startingToken: "a".repeat(64) };
      delete target.session;
      return { ...result, target: hasStartingTarget ? target : undefined };
    };
    deps.now = () => now;
    deps.pollMs = 1_000;
    deps.identity = async (_server, candidate) => candidate.pane_id === from.pane ? SESSION : now - launchedAt >= delay ? NEXT : undefined;
    const linking: MoveRecord[] = [];
    deps.sleep = async ms => {
      now += ms;
      const record = (await listMoves(now))[0];
      if (record && record.state === "linking") linking.push(record);
    };
    const record = await move(deps, { harness: "codex" }, { mode: "new-chat" });
    expect(linking.length).toBeGreaterThan(0);
    expect(linking.some(row => Date.parse(row.updatedAt) >= launchedAt)).toBe(true);
    expect(linking.every(row => !row.handedOffTo && !row.handedOffFrom)).toBe(true);
    expect(record.state).toBe("moved");
    expect(pane.agent).toBe("claude");
    expect(closed).toEqual([]);
    if (Number.isFinite(delay)) {
      expect(now - launchedAt).toBeGreaterThanOrEqual(45_000);
      expect(record.target).toMatchObject({ pane: "w1:p2", source: "codex", session: NEXT });
      expect(object(record).linkPending).not.toBe(true);
      expect(moveSessionFields([record], record.target as Target)).toEqual({ handedOffFrom: { target: from, title: "parser fix" } });
      expect(record.handedOffTo).toEqual({ target: record.target });
    } else {
      expect(now - launchedAt).toBeGreaterThanOrEqual(120_000);
      expect(now - launchedAt).toBeLessThanOrEqual(300_000);
      if (hasStartingTarget) expect(record.target).toMatchObject({ pane: "w1:p2", starting: true });
      else expect(record.target).toBeUndefined();
      expect(record.paneTarget).toEqual({ server: "default", workspace: "w1", tab: "w1:t2", pane: "w1:p2", source: "codex" });
      expect(object(record)).toMatchObject({ linkPending: true, notice: expect.stringContaining("link is pending") });
    }
  });

  it("keeps the source unlabelled and running when a new-chat launch fails", async () => {
    const { deps, pane, typed, closed } = world({ reply: writes });
    deps.launch = async () => { throw new Error("launch failed"); };
    const record = await move(deps, { harness: "codex" }, { mode: "new-chat" });
    expect(record).toMatchObject({ state: "failed", error: "launch failed" });
    expect(pane.agent).toBe("claude");
    expect(typed).toHaveLength(1);
    expect(closed).toEqual([]);
    expect(moveSessionFields([record], from)).toEqual({});
  });

  it("builds the hand-off from the transcript, git state and original brief when the agent writes none in time", async () => {
    const { deps } = world();
    const record = await move(deps, { harness: "codex" }, { handoffTimeoutMs: 5_000 });

    expect(record).toMatchObject({ state: "moved", handoff: { source: "fallback", reason: expect.stringContaining("did not reply") } });
    const handoff = await readFile(record.handoff!.path, "utf8");
    expect(handoff).toContain("Fix the parser and open a PR");
    expect(handoff).toContain("edited src/parser.ts");
    expect(handoff).toContain("Original brief: fix the parser, open a PR, do not merge.");
    expect(handoff).toContain(" M src/parser.ts");
    // The move's own request is not part of the work it hands over.
    expect(handoff).not.toContain("Do not commit, stash");
  });

  it.each([
    [{ harness: "opencode" }, "harness_unavailable"],
    [{ harness: "claude", account: "spare" }, "account_unavailable"],
    [{ harness: "claude", account: "nobody" }, "account_unavailable"],
  ])("refuses %j before typing anything", async (to, code) => {
    const { deps, typed } = world({ reply: writes });
    await expect(new SessionMover(deps).start({ target: from, to })).rejects.toMatchObject({ status: 409, details: { code } });
    expect(typed).toEqual([]);
    expect(await listMoves()).toEqual([]);
  });

  it("interrupts, then kills, an agent that does not exit by itself", async () => {
    const { deps, keys, killed } = world({ reply: writes, exits: false });
    const record = await move(deps, { harness: "codex" });

    expect(record).toMatchObject({ state: "moved", exit: "killed" });
    expect(keys).toContainEqual(["ctrl+c"]);
    // The pane's shell is never signalled, only the agent.
    expect(killed).toEqual(["SIGTERM 11", "SIGKILL 11"]);
  });

  it("starts a Claude account the Herdr pane's shell does not carry in a new tab beside it, and closes the old pane", async () => {
    const herdr = world({ reply: writes });
    const record = await move(herdr.deps, { harness: "claude", account: "work" });
    expect(record).toMatchObject({ state: "moved", placement: "adjacent-pane", to: { account: "work" }, target: { pane: "w1:p2" } });
    expect(herdr.launches[0].options.into).toBeUndefined();
    expect(herdr.launches[0].data).toMatchObject({ account: "work", workspaceId: "w1" });
    expect(herdr.closed).toEqual(["w1:p1"]);

    // tmux sets the variables on every start, so the same pane takes it.
    const tmux = world({ reply: writes, tmux: true });
    expect(await move(tmux.deps, { harness: "claude", account: "work" })).toMatchObject({ placement: "same-pane" });
  });
});

describe("a dispatch whose worker moved", () => {
  const record = (state: MoveRecord["state"]): MoveRecord => ({ id: "50000000-0000-4000-8000-000000000005", state, createdAt: "2026-10-10T12:00:00.000Z", updatedAt: "2026-10-10T12:01:00.000Z",
    from: { target: from, account: "default" }, to: { harness: "codex", model: "gpt-5.5" }, cwd: "/work/repo", dispatch: DISPATCH,
    ...(state === "moved" ? { movedAt: "2026-10-10T12:01:00.000Z", handoff: { path: "/bridge/briefs/x/handoff.md", source: "agent" as const, chars: 10 },
      target: { ...from, source: "codex" as const, session: NEXT } } : {}) });
  const newPane = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "codex", agent_status: "working", terminal_id: "term-1" };
  const readers = (move: MoveRecord) => ({ snapshot: async () => ({ panes: [newPane] }), identity: async () => NEXT, finalTurn: async () => undefined,
    moves: async () => [move] });

  it("reads as working while the move runs, then follows the new agent and records the move once on the receipt", async () => {
    const asked = { targets: [{ ...from, dispatch: DISPATCH }] };
    const moving = await workerStates(asked, readers(record("handing-off")));
    expect(moving.workers[0]).toMatchObject({ state: "working", moving: record("handing-off").id });

    const moved = await workerStates(asked, readers(record("moved")));
    expect(moved.workers[0]).toMatchObject({ state: "working", session: NEXT, moved: { to: { harness: "codex" }, target: { source: "codex", session: NEXT } } });

    const receipt = { id: DISPATCH, computer: "omarchy", project: "phren", harness: "claude", account: "default", label: "parser fix", createdAt: "2026-10-10T11:00:00.000Z",
      updatedAt: "2026-10-10T11:00:00.000Z", state: "accepted", target: from, worker: { state: "working", since: "2026-10-10T11:00:00.000Z", checkedAt: "2026-10-10T11:00:00.000Z", sawWorking: true } } as Receipt;
    expect(observe(receipt, moved.workers[0], Date.parse("2026-10-10T12:02:00Z"))).toBe(true);
    expect(receipt).toMatchObject({ id: DISPATCH, harness: "codex", model: "gpt-5.5", target: { source: "codex", session: NEXT },
      moves: [{ id: record("moved").id, from: { harness: "claude", account: "default" }, to: { harness: "codex" }, handoff: "/bridge/briefs/x/handoff.md" }] });
    expect(receipt.account).toBeUndefined();
    observe(receipt, moved.workers[0], Date.parse("2026-10-10T12:03:00Z"));
    expect(receipt.moves).toHaveLength(1);
  });
});

const object = (value: unknown): Json => value && typeof value === "object" ? value as Json : {};
