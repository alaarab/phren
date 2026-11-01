import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
const state = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(),
  execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: state.exec }),
}));
import { opencodePidSession, paneChatState, paneIdentity } from "./herdr.js";
import { recordedSession } from "./agent-hooks.js";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("accepts an opencode ses_ session reported by Herdr", async () => {
  const pane = { pane_id: "p1", terminal_id: "term", agent: "opencode",
    agent_session: { kind: "id", agent: "opencode", source: "herdr:opencode", value: "ses_f4a6b5c11ffe6nZrRlGZbXXNli" } };
  expect(await paneIdentity("default", pane)).toBe("ses_f4a6b5c11ffe6nZrRlGZbXXNli");
});
it("binds an OpenCode pane from phren's plugin by PID when Herdr reports no session", async () => {
  const root = await mkdtemp(path.join((await import("node:os")).tmpdir(), "phren-oc-"));
  const folder = path.join(root, ".runtime", "sessions");
  await mkdir(folder, { recursive: true });
  try {
    await writeFile(path.join(folder, "opencode-pid-10.json"), JSON.stringify({ session: "ses_old1", at: "2026-09-25T10:00:00Z" }));
    await writeFile(path.join(folder, "opencode-pid-11.json"), JSON.stringify({ session: "ses_new2", at: "2026-09-25T11:00:00Z" }));
    await writeFile(path.join(folder, "opencode-pid-12.json"), JSON.stringify({ session: "ses_gone3", at: "2026-09-25T12:00:00Z" }));
    await writeFile(path.join(folder, "opencode-pid-13.json"), "not json");
    await writeFile(path.join(folder, "opencode-ses_old1.events.jsonl"), "");
    await writeFile(path.join(folder, "opencode-ses_new2.events.jsonl"), "");
    // The newest binding with a transcript wins; one whose transcript is missing is skipped.
    expect(await opencodePidSession([10, 11, 12, 13], root)).toBe("ses_new2");
    expect(await opencodePidSession([10], root)).toBe("ses_old1");
    expect(await opencodePidSession([12, 13, 99], root)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
// Herdr is reached over a Unix domain socket, which Node cannot listen on at a file path on Windows.
it.skipIf(process.platform === "win32")("caches identity per server, pane, terminal and PID set for two seconds, with fresh bypass", async () => {
  const root = await mkdtemp("/tmp/phren-identity-");
  vi.stubEnv("PHREN_HERDR_HOME", root); vi.stubEnv("PHREN_BRIDGE_HOME", root + "/bridge");
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  let now = 0; vi.spyOn(Date, "now").mockImplementation(() => now);
  let pid = 100, session = "aaaaaaaa-1111-4111-8111-111111111111";
  state.exec.mockImplementation(async () => ({ stdout: `n/tmp/rollout-now-${session}.jsonl\n` }));
  const servers: Server[] = [];
  try {
    for (const name of ["", "sessions/work"]) {
      await mkdir(path.join(root, name), { recursive: true });
      const server = createServer(socket => {
        let text = ""; socket.on("data", bytes => {
          text += bytes; if (!text.includes("\n")) return;
          const request = JSON.parse(text);
          socket.end(JSON.stringify({ id: request.id, result: { process_info: { foreground_processes: [{ pid }] } } }) + "\n");
        });
      });
      servers.push(server); await new Promise<void>(resolve => server.listen(path.join(root, name, "herdr.sock"), resolve));
    }
    const pane = { pane_id: "p1", terminal_id: "term", agent: "codex" };
    expect(await Promise.all([paneIdentity("default", pane), paneIdentity("default", pane)])).toEqual([session, session]);
    expect(state.exec).toHaveBeenCalledTimes(1);
    const old = session; session = "bbbbbbbb-1111-4111-8111-111111111111"; now = 1999;
    expect(await paneIdentity("default", pane)).toBe(old);
    expect(await paneIdentity("default", pane, true)).toBe(session); expect(state.exec).toHaveBeenCalledTimes(2);
    pid++;
    await paneIdentity("default", pane); expect(state.exec).toHaveBeenCalledTimes(3);
    await paneIdentity("default", { ...pane, terminal_id: "new" }); expect(state.exec).toHaveBeenCalledTimes(4);
    await paneIdentity("work", pane); expect(state.exec).toHaveBeenCalledTimes(5);
    await paneIdentity("default", { ...pane, pane_id: "p2" }); expect(state.exec).toHaveBeenCalledTimes(6);
    now += 2000; await paneIdentity("default", pane); expect(state.exec).toHaveBeenCalledTimes(7);
    // A dot server must never read a binding from the parent folder.
    await mkdir(root + "/bridge/bindings", { recursive: true });
    await writeFile(root + "/bridge/p1.json", JSON.stringify({ terminal: "term", source: "codex", pids: [pid], session }));
    expect(await recordedSession("..", pane, [pid])).toBeUndefined();
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(root, { recursive: true, force: true });
  }
});
it.skipIf(process.platform === "win32")("names a Copilot pane by the conversation its process log registered, not Herdr's stale report", async () => {
  const root = await mkdtemp("/tmp/phren-identity-");
  vi.stubEnv("PHREN_HERDR_HOME", root); vi.stubEnv("COPILOT_HOME", root + "/copilot");
  const old = "67fff5f5-131b-4a29-b1fc-6bd7f0fb45e3", fresh = "f27fdb49-70da-4c9d-b8ce-aa52b9dce81d";
  const server = createServer(socket => {
    let text = ""; socket.on("data", bytes => {
      text += bytes; if (!text.includes("\n")) return;
      const request = JSON.parse(text);
      socket.end(JSON.stringify({ id: request.id, result: { process_info: { foreground_processes: [{ pid: 4242 }] } } }) + "\n");
    });
  });
  try {
    await mkdir(root + "/copilot/logs", { recursive: true });
    await new Promise<void>(resolve => server.listen(path.join(root, "herdr.sock"), resolve));
    const log = (lines: string[]) => writeFile(root + "/copilot/logs/process-1790311502722-4242.log", lines.map(line => `${line}\n`).join(""));
    const pane = { pane_id: "cp", terminal_id: "term", agent: "copilot",
      agent_session: { kind: "id", agent: "copilot", source: "herdr:copilot", value: old } };
    // With no log for the process, Herdr's report still names the pane.
    expect(await paneIdentity("default", pane, true)).toBe(old);
    // /new: Copilot switches conversation in the same process; its sessionStart
    // hook (and so Herdr's report) waits for the first prompt.
    await log([`2026-09-25T04:45:03.046Z [INFO] Registering foreground session: ${old}`,
      `2026-09-25T04:49:28.680Z [INFO] Unregistering foreground session: ${old}`,
      `2026-09-25T04:49:28.692Z [INFO] Registering foreground session: ${fresh}`]);
    // Nothing sent there yet: no transcript, so the pane is starting.
    expect(await paneIdentity("default", pane, true)).toBeUndefined();
    await mkdir(`${root}/copilot/session-state/${fresh}`, { recursive: true });
    await writeFile(`${root}/copilot/session-state/${fresh}/events.jsonl`, "{}\n");
    expect(await paneIdentity("default", pane, true)).toBe(fresh);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps the completed starting evidence when scheduling outlasts the cache window", async () => {
  const root = await mkdtemp(path.join((await import("node:os")).tmpdir(), "phren-starting-evidence-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 3_000));
  state.exec.mockResolvedValue({ stdout: "" });
  const { setTerminalProvider } = await import("./terminal.js");
  const restore = setTerminalProvider({
    processes: async () => ({ foregroundPids: [999_999_997] }),
  } as unknown as import("./terminal.js").TerminalProvider);
  try {
    const pane = { pane_id: "starting-evidence", terminal_id: root, agent: "codex" };
    expect(await paneChatState("default", pane)).toMatchObject({ starting: true, startingToken: expect.stringMatching(/^[a-f0-9]{64}$/) });
    // A changed process with ambiguous logs must never receive first-send permission.
    state.exec.mockResolvedValue({ stdout: "n/tmp/rollout-a-aaaaaaaa-1111-4111-8111-111111111111.jsonl\nn/tmp/rollout-b-bbbbbbbb-1111-4111-8111-111111111111.jsonl\n" });
    expect(await paneChatState("default", { ...pane, terminal_id: root + "-changed" })).not.toHaveProperty("starting");
  } finally { restore(); await rm(root, { recursive: true, force: true }); }
});

it("names a Claude pane by the Hook's binding when Herdr still reports a finished nested claude -p run", async () => {
  const root = await mkdtemp(path.join((await import("node:os")).tmpdir(), "phren-nested-claude-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  state.exec.mockResolvedValue({ stdout: "" });
  const { setTerminalProvider } = await import("./terminal.js");
  const restore = setTerminalProvider({ processes: async () => ({ foregroundPids: [4242] }) } as unknown as import("./terminal.js").TerminalProvider);
  const own = "84bef99f-7ba9-42e9-9023-475a56d0b234", nested = "3d6267ab-1cf9-43cc-9173-7fb28a22a0fe";
  const pane = { pane_id: "wFQ:p1", terminal_id: "term", agent: "claude",
    agent_session: { kind: "id", agent: "claude", source: "herdr:claude", value: nested } };
  const bind = (session: string) => writeFile(path.join(root, "bindings", "default", encodeURIComponent("wFQ:p1") + ".json"),
    JSON.stringify({ terminal: "term", source: "claude", session, pids: [4242] }));
  try {
    await mkdir(path.join(root, "bindings", "default"), { recursive: true });
    await bind(nested);
    // With no open transcript, the PID-verified binding names the pane.
    expect(await paneIdentity("default", pane, true)).toBe(nested);
    // The pane's own conversation kept running after the nested run exited.
    await bind(own);
    expect(await paneIdentity("default", pane, true)).toBe(own);
  } finally { restore(); await rm(root, { recursive: true, force: true }); }
});

it.each([
  { binding: "stale", refresh: "expiry" },
  { binding: "absent", refresh: "expiry" },
  { binding: "stale", refresh: "fresh" },
  { binding: "absent", refresh: "fresh" },
])("follows Claude's foreground transcript with a $binding binding and stale Herdr report after $refresh", async ({ binding, refresh }) => {
  const scratch = path.resolve(".scratch");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "phren-claude-switch-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const old = "aaaaaaaa-1111-4111-8111-111111111111", current = "bbbbbbbb-1111-4111-8111-111111111111";
  let transcript = old;
  state.exec.mockReset().mockImplementation(async () => ({ stdout: `n${root}/${transcript}.jsonl\n` }));
  const { setTerminalProvider } = await import("./terminal.js");
  const restore = setTerminalProvider({ processes: async () => ({ foregroundPids: [4242] }) } as unknown as import("./terminal.js").TerminalProvider);
  const pane = { pane_id: "claude-switch", terminal_id: root, agent: "claude",
    agent_session: { kind: "id", agent: "claude", value: old } };
  try {
    if (binding === "stale") {
      await mkdir(path.join(root, "bindings", "default"), { recursive: true });
      await writeFile(path.join(root, "bindings", "default", "claude-switch.json"),
        JSON.stringify({ terminal: root, source: "claude", session: old, pids: [4242] }));
    }
    expect(await paneIdentity("default", pane)).toBe(old);
    // A clear/resume changes the transcript held by the same foreground PID;
    // neither the reported session nor the lifecycle binding has caught up.
    transcript = current; now = 1999;
    expect(await paneIdentity("default", pane)).toBe(old);
    if (refresh === "expiry") now = 2000;
    expect(await paneIdentity("default", pane, refresh === "fresh")).toBe(current);
    expect(state.exec).toHaveBeenCalledTimes(2);
    expect(await paneIdentity("default", pane)).toBe(current);
    expect(state.exec).toHaveBeenCalledTimes(2);
  } finally { restore(); await rm(root, { recursive: true, force: true }); }
});

it.each([
  { label: "no transcript or binding", transcripts: [], binding: undefined, bindingPid: 4242, report: "valid", expected: "report" },
  { label: "an unverified binding", transcripts: [], binding: "binding", bindingPid: 4243, report: "valid", expected: "report" },
  { label: "contradictory ambiguous transcripts", transcripts: ["binding", "other"], binding: undefined, bindingPid: 4242, report: "valid", expected: undefined },
  { label: "a verified binding among ambiguous transcripts", transcripts: ["binding", "other"], binding: "binding", bindingPid: 4242, report: "valid", expected: "binding" },
  { label: "a binding contradicted by ambiguous transcripts", transcripts: ["binding", "other"], binding: "report", bindingPid: 4242, report: "valid", expected: undefined },
  { label: "an invalid report", transcripts: [], binding: undefined, bindingPid: 4242, report: "invalid", expected: undefined },
  { label: "a report for another agent", transcripts: [], binding: undefined, bindingPid: 4242, report: "other-agent", expected: undefined },
])("resolves Claude's report fallback with $label", async ({ transcripts, binding, bindingPid, report, expected }) => {
  const scratch = path.resolve(".scratch");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "phren-claude-fallback-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  const sessions: Record<string, string> = { report: "aaaaaaaa-1111-4111-8111-111111111111",
    binding: "bbbbbbbb-1111-4111-8111-111111111111", other: "cccccccc-1111-4111-8111-111111111111" };
  state.exec.mockReset().mockResolvedValue({ stdout: transcripts.map(name => `n${root}/${sessions[name]}.jsonl\n`).join("") });
  const { setTerminalProvider } = await import("./terminal.js");
  const restore = setTerminalProvider({ processes: async () => ({ foregroundPids: [4242] }) } as unknown as import("./terminal.js").TerminalProvider);
  const pane = { pane_id: "claude-fallback", terminal_id: root, agent: "claude",
    agent_session: { kind: "id", agent: report === "other-agent" ? "codex" : "claude", value: report === "invalid" ? "invalid" : sessions.report } };
  try {
    if (binding) {
      await mkdir(path.join(root, "bindings", "default"), { recursive: true });
      await writeFile(path.join(root, "bindings", "default", "claude-fallback.json"),
        JSON.stringify({ terminal: root, source: "claude", session: sessions[binding], pids: [bindingPid] }));
    }
    expect(await paneIdentity("default", pane, true)).toBe(expected ? sessions[expected] : undefined);
    if (!binding && transcripts.length === 0 && report === "valid") {
      // A report can change before the cached empty process evidence expires.
      const changed = { ...pane, agent_session: { ...pane.agent_session, value: sessions.other } };
      expect(await paneIdentity("default", changed)).toBe(sessions.other);
      expect(state.exec).toHaveBeenCalledTimes(1);
    }
  } finally { restore(); await rm(root, { recursive: true, force: true }); }
});
