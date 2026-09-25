import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
const state = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(),
  execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: state.exec }),
}));
import { opencodePidSession, paneIdentity } from "./herdr.js";
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
