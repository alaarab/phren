import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Json } from "./protocol.js";
import { sudoPushPayload } from "./push.js";
import { overviewStream, type OverviewClient } from "./server-overview.js";
import { askpassEnv, askpassPath, askpassScript, installAskpass, MAX_SUDO_PENDING, removeAskpass, SudoBroker, sudoAnswer, sudoCommand, verifyAsker,
  type ProcessRecord, type SudoReply, type SudoRequestView } from "./sudo.js";
import { headlessEnv } from "./schedule-launch.js";

const ASKPASS = 4242, SCRIPT = 4241, SUDO = 4240;
const NODE = "/opt/node/bin/node", BUNDLE = "/home/me/.local/share/phren/bridge/current/bridge-hook.mjs", SCRIPT_PATH = "/home/me/.local/share/phren/bridge/askpass";
const sudoArgv = ["sudo", "-A", "killall", "-HUP", "mDNSResponder"];
function chain(overrides: { asker?: Partial<ProcessRecord>; script?: Partial<ProcessRecord>; sudo?: Partial<ProcessRecord> } = {}) {
  const records: Record<number, ProcessRecord> = {
    [ASKPASS]: { ppid: SCRIPT, euid: 501, name: "node", argv: [NODE, BUNDLE, "askpass", "Password:"], line: `${NODE} ${BUNDLE} askpass Password:`, ...overrides.asker },
    [SCRIPT]: { ppid: SUDO, euid: 501, name: "sh", argv: ["/bin/sh", SCRIPT_PATH, "Password:"], line: `/bin/sh ${SCRIPT_PATH} Password:`, ...overrides.script },
    [SUDO]: { ppid: 1, euid: 0, name: "sudo", argv: sudoArgv, line: sudoArgv.join(" "), ...overrides.sudo },
  };
  return async (pid: number) => records[pid];
}
const check = (processes = chain(), stdout: "sudo" | "other" | "unknown" = "sudo", connection: "asker" | "other" | "unknown" = "asker") => ({ processes, node: NODE, bundles: [BUNDLE], script: SCRIPT_PATH,
  stdout: async (pid: number, allowed: number[]) => { expect([pid, allowed]).toEqual([ASKPASS, [SCRIPT, SUDO]]); return stdout; },
  connection: async (pid: number) => { expect(pid).toBe(ASKPASS); return connection; } });

function broker(options: { push?: boolean | "fails"; holdMs?: number; refused?: boolean; sudoRunning?: () => boolean; deliver?: SudoReply } = {}) {
  const pushed: SudoRequestView[] = [];
  const push = options.push === undefined || options.push === false ? undefined : {
    available: true,
    notifySudo: async (value: SudoRequestView) => { pushed.push(value); return options.push !== "fails"; },
  };
  const value = new SudoBroker({ computer: () => "Mini", account: "me", outcomeMs: 1_000,
    processes: async pid => pid === SUDO && (options.sudoRunning?.() ?? false) ? { ppid: 1, euid: 0, name: "sudo", argv: sudoArgv, line: "", started: "Tue Sep 29 11:00:00 2026" } : undefined,
    holdMs: options.holdMs ?? 60_000, now: () => Date.parse("2026-09-29T18:00:00Z"),
    ...(push ? { push } : {}),
    verify: async pid => {
      if (options.refused) return { refused: "phren askpass only answers sudo -A." };
      const verified = await verifyAsker(pid, check());
      return "refused" in verified ? verified
        : { ...verified, sudo: { ...verified.sudo, started: "Tue Sep 29 11:00:00 2026" }, deliver: async (password: string) => options.deliver ?? { password } };
    },
    describe: async place => place.pane === "w1:p1" ? { source: "claude", label: "phren" } : undefined });
  return { broker: value, pushed };
}
const replies = () => { const list: SudoReply[] = []; return { list, respond: (reply: SudoReply) => { list.push(reply); } }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

describe("sudo command line", () => {
  it("drops sudo's own options and keeps the target user", () => {
    expect(sudoCommand(["sudo", "-A", "killall", "-HUP", "mDNSResponder"])).toEqual({ command: "killall -HUP mDNSResponder" });
    expect(sudoCommand(["sudo", "-A", "-u", "postgres", "psql", "-c", "select 1"])).toEqual({ command: "psql -c select 1", user: "postgres" });
    expect(sudoCommand(["sudo", "-Au", "www", "id"])).toEqual({ command: "id", user: "www" });
    expect(sudoCommand(["sudo", "-uroot", "-n", "id"])).toEqual({ command: "id", user: "root" });
    expect(sudoCommand(["sudo", "--user=admin", "--preserve-env", "--", "-weird"])).toEqual({ command: "-weird", user: "admin" });
    expect(sudoCommand(["sudo", "-A", "-p", "Password:", "--chdir", "/tmp", "ls"])).toEqual({ command: "ls" });
  });
  it("shows the whole line when sudo runs no command", () => {
    expect(sudoCommand(["sudo", "-A", "-v"])).toEqual({ command: "sudo -A -v" });
  });
  it("bounds a very long command", () => {
    expect(sudoCommand(["sudo", "echo", "x".repeat(5_000)]).command).toHaveLength(2_000);
  });
});

describe("sudo answers", () => {
  const id = "5b0e6a3e-6f53-4b4c-9d1a-0d7c1c1b2a11";
  it("accepts a one-line password or a deny", () => {
    expect(sudoAnswer({ id, password: "p a$$ 'w\"" })).toEqual({ id, answer: { password: "p a$$ 'w\"" }, outcome: false });
    expect(sudoAnswer({ id, password: "pw", outcome: true })).toEqual({ id, answer: { password: "pw" }, outcome: true });
    expect(sudoAnswer({ id, deny: true })).toEqual({ id, answer: { deny: true }, outcome: false });
  });
  it("refuses what sudo would cut, without echoing it", () => {
    for (const bad of [{ id, password: "" }, { id, password: "two\nlines" }, { id, password: "nul\0" }, { id, password: "x".repeat(1_025) },
      { id: "nope", password: "secret-value" }, { id, password: 7 }, { id, deny: true, password: "both" }, { id, password: "secret-value", outcome: "yes" }]) {
      let message = "";
      try { sudoAnswer(bad as Json); } catch (error) { message = String(error); }
      expect(message).toMatch(/Send an id and a password, or deny/);
      expect(message).not.toMatch(/secret-value|two|lines|both/);
    }
  });
});

describe("askpass chain", () => {
  it("accepts this Hook's node and bundle, under its script, under a root sudo, writing to sudo alone", async () => {
    expect(await verifyAsker(ASKPASS, check())).toEqual({ sudo: expect.objectContaining({ euid: 0, argv: sudoArgv }), sudoPid: SUDO });
  });
  const refusals: [string, Parameters<typeof chain>[0], RegExp][] = [
    // Anything of the owner's can name itself sudo; only the real one runs as root.
    ["a sudo not running as root", { sudo: { euid: 501 } }, /only answers sudo -A/],
    ["a parent that is not sudo", { sudo: { name: "bash" } }, /only answers sudo -A/],
    // An agent's own SUDO_ASKPASS would receive the password itself.
    ["another askpass program", { script: { line: "/bin/sh /tmp/steal.sh Password:" } }, /Only .*askpass may ask/],
    ["node with flags that load code", { asker: { line: `${NODE} --import /tmp/x.mjs ${BUNDLE} askpass` } }, /Only .*askpass may ask/],
    ["another program", { asker: { line: "/tmp/steal askpass" } }, /Only .*askpass may ask/],
    ["NODE_OPTIONS in the asker", { asker: { env: ["HOME", "NODE_OPTIONS"] } }, /loads other code/],
    ["LD_PRELOAD in the script", { script: { env: ["LD_PRELOAD"] } }, /loads other code/],
    ["DYLD_INSERT_LIBRARIES in the asker", { asker: { env: ["DYLD_INSERT_LIBRARIES"] } }, /loads other code/],
  ];
  for (const [name, overrides, message] of refusals) {
    it(`refuses ${name}`, async () => {
      expect(await verifyAsker(ASKPASS, check(chain(overrides)))).toEqual({ refused: expect.stringMatching(message) });
    });
  }
  it("refuses output that goes anywhere but sudo, or that cannot be checked", async () => {
    expect(await verifyAsker(ASKPASS, check(chain(), "other"))).toEqual({ refused: "askpass's output must go to sudo alone." });
    expect(await verifyAsker(ASKPASS, check(chain(), "unknown"))).toEqual({ refused: "Phren Hook could not check where askpass's output goes." });
  });
  it("lets the script carry NODE_OPTIONS, which it drops before node starts", async () => {
    expect(await verifyAsker(ASKPASS, check(chain({ script: { env: ["NODE_OPTIONS"] } })))).toHaveProperty("sudo");
  });
  it("refuses a connection that is not the asker's alone", async () => {
    // Another process naming a waiting askpass's pid must not get its password.
    expect(await verifyAsker(ASKPASS, check(chain(), "sudo", "other"))).toEqual({ refused: "Only askpass itself may ask for its password." });
    expect(await verifyAsker(ASKPASS, check(chain(), "sudo", "unknown"))).toEqual({ refused: "Phren Hook could not check who asked." });
  });
  it("refuses a vanished process", async () => {
    expect(await verifyAsker(99, check())).toEqual({ refused: "phren askpass only answers sudo -A." });
  });
});

describe("sudo broker", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("asks nothing of the phone when the chain is refused", async () => {
    const { broker: value, pushed } = broker({ push: true, refused: true });
    const out = replies();
    await value.ask({ pid: ASKPASS }, out.respond);
    expect(out.list).toEqual([{ status: 400, error: "phren askpass only answers sudo -A." }]);
    expect(value.list()).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("fails at once when no phone can answer", async () => {
    const { broker: value } = broker();
    const out = replies();
    await value.ask({ pid: ASKPASS }, out.respond);
    expect(out.list[0]).toMatchObject({ status: 503 });
    expect(out.list[0]).toHaveProperty("error", expect.stringMatching(/No phone can answer sudo/));
  });

  it("pushes the exact command and session, hands the password over once, and forgets it", async () => {
    const { broker: value, pushed } = broker({ push: true });
    const seen: SudoRequestView[][] = [];
    const stop = value.subscribe(requests => seen.push(requests));
    const out = replies();
    await value.ask({ pid: ASKPASS, cwd: "/Users/me/project", place: { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1" } }, out.respond);
    const [request] = value.list();
    expect(request).toEqual({ id: expect.any(String), computer: "Mini", command: "killall -HUP mDNSResponder", account: "me", cwd: "/Users/me/project",
      session: { source: "claude", label: "phren", server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1" },
      askedAt: "2026-09-29T18:00:00.000Z", expiresAt: "2026-09-29T18:01:00.000Z" });
    expect(pushed).toEqual([request]);
    expect(value.answer(request.id, { password: "hunter2" })).toBeTruthy();
    await settle();
    expect(out.list).toEqual([{ password: "hunter2" }]);
    // Single use: gone from the list, a second answer finds nothing.
    expect(value.answer(request.id, { password: "again" })).toBe(false);
    expect(out.list).toHaveLength(1);
    expect(value.list()).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain("hunter2");
    expect(seen.map(list => list.length)).toEqual([1, 0]);
    stop();
  });

  it("denies, times out, and drops a request whose asker went away", async () => {
    vi.useFakeTimers();
    const { broker: value } = broker({ push: true, holdMs: 1_000 });
    const denied = replies(), late = replies(), gone = replies();
    await value.ask({ pid: ASKPASS }, denied.respond);
    value.answer(value.list()[0].id, { deny: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(denied.list).toEqual([{ status: 403, error: "Denied on the phone." }]);
    await value.ask({ pid: ASKPASS }, late.respond);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(late.list).toEqual([{ status: 408, error: "No answer from the phone in time." }]);
    const held = await value.ask({ pid: ASKPASS }, gone.respond);
    const id = value.list()[0].id;
    held.cancel();
    expect(value.list()).toEqual([]);
    expect(value.answer(id, { password: "late" })).toBe(false);
    expect(gone.list).toEqual([]);
  });

  it("gives up when the push fails and no phone is watching, but waits for a watching phone", async () => {
    const { broker: value } = broker({ push: "fails" });
    const out = replies();
    await value.ask({ pid: ASKPASS }, out.respond);
    await settle(); await settle(); await settle();
    expect(out.list[0]).toMatchObject({ status: 503, error: "The phone could not be reached for sudo." });
    const stop = value.subscribe(() => {});
    const watched = replies();
    await value.ask({ pid: ASKPASS }, watched.respond);
    await settle(); await settle();
    expect(watched.list).toEqual([]);
    expect(value.list()).toHaveLength(1);
    stop(); value.close();
    await settle();
    expect(watched.list[0]).toMatchObject({ status: 503 });
  });

  it("caps held requests", async () => {
    const { broker: value } = broker({ push: true });
    for (let n = 0; n < MAX_SUDO_PENDING; n++) await value.ask({ pid: ASKPASS }, () => {});
    const out = replies();
    await value.ask({ pid: ASKPASS }, out.respond);
    expect(out.list[0]).toMatchObject({ status: 429 });
    value.close();
  });
});

describe("whether sudo took the password", () => {
  afterEach(() => { vi.useRealTimers(); });
  const answered = async (value: SudoBroker) => {
    await value.ask({ pid: ASKPASS }, () => {});
    const result = value.answer(value.list()[0].id, { password: "pw" });
    if (!result) throw new Error("not pending");
    // Wrapped: an async function returning the promise itself would wait for it.
    return { outcome: result.outcome };
  };

  it("is rejected when the same sudo asks again", async () => {
    const { broker: value } = broker({ push: true });
    const { outcome } = await answered(value);
    await settle();
    await value.ask({ pid: ASKPASS }, () => {});
    expect(await outcome).toBe("rejected");
    expect(value.list()).toHaveLength(1);
    value.close();
  });

  it("is rejected even when the second ask cannot reach a phone", async () => {
    const { broker: value } = broker({ push: false });
    const stop = value.subscribe(() => {});
    const { outcome } = await answered(value);
    await settle();
    stop();
    const out = replies();
    await value.ask({ pid: ASKPASS }, out.respond);
    expect(out.list[0]).toMatchObject({ status: 503 });
    expect(await outcome).toBe("rejected");
  });

  it("is accepted when sudo does not ask again on an early try, or is still running", async () => {
    vi.useFakeTimers();
    const { broker: value } = broker({ push: true });
    const { outcome } = await answered(value);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toBe("accepted");
  });

  it("is unknown after the last try when sudo is gone, accepted when it still runs", async () => {
    vi.useFakeTimers();
    let running = false;
    const { broker: value } = broker({ push: true, sudoRunning: () => running });
    const first = (await answered(value)).outcome; await vi.advanceTimersByTimeAsync(0);
    await value.ask({ pid: ASKPASS }, () => {}); expect(await first).toBe("rejected");
    const second = value.answer(value.list()[0].id, { password: "pw" }); if (!second) throw new Error("not pending");
    await vi.advanceTimersByTimeAsync(0);
    await value.ask({ pid: ASKPASS }, () => {}); expect(await second.outcome).toBe("rejected");
    const third = value.answer(value.list()[0].id, { password: "pw" }); if (!third) throw new Error("not pending");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await third.outcome).toBe("unknown");
    running = true;
    await value.ask({ pid: ASKPASS }, () => {});
    const fourth = value.answer(value.list()[0].id, { password: "pw" }); if (!fourth) throw new Error("not pending");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await fourth.outcome).toBe("accepted");
  });

  it("is unknown when the password could not be handed over, and absent for a deny", async () => {
    const { broker: value } = broker({ push: true, deliver: { status: 410, error: "askpass went away." } });
    expect(await (await answered(value)).outcome).toBe("unknown");
    await value.ask({ pid: ASKPASS }, () => {});
    const denied = value.answer(value.list()[0].id, { deny: true });
    expect(denied && await denied.outcome).toBeUndefined();
  });
});

describe("sudo push", () => {
  it("names the computer and command, carries no password, and redacts secrets in the command", () => {
    const payload = sudoPushPayload({ id: "5b0e6a3e-6f53-4b4c-9d1a-0d7c1c1b2a11", computer: "Mini", command: "killall -HUP mDNSResponder",
      askedAt: "2026-09-29T18:00:00.000Z", expiresAt: "2026-09-29T18:02:00.000Z" }, "host-1");
    expect(payload).toEqual({
      aps: { alert: { title: "sudo on Mini", body: "killall -HUP mDNSResponder" }, sound: "default", category: "PHREN_SUDO", "interruption-level": "time-sensitive" },
      phren: { version: 1, kind: "sudo", id: "5b0e6a3e-6f53-4b4c-9d1a-0d7c1c1b2a11", host: "host-1", computer: "Mini", command: "killall -HUP mDNSResponder", expiresAt: "2026-09-29T18:02:00.000Z" },
    });
    const secret = sudoPushPayload({ id: "5b0e6a3e-6f53-4b4c-9d1a-0d7c1c1b2a11", computer: "Mini", command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789' x",
      askedAt: "", expiresAt: "" });
    expect(JSON.stringify(secret)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

class FakeClient extends EventEmitter implements OverviewClient {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  frames: Json[] = [];
  send(data: string) { this.frames.push(JSON.parse(data)); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
}

describe("sudo on the overview socket", () => {
  it("sends pending requests after the first overview and on each change, only to a phone that asked", async () => {
    const { broker: value } = broker({ push: false });
    const stream = overviewStream({ info: () => ({}), renew: () => {}, tickMs: 60_000, sudo: value,
      snapshot: async () => ({ panes: [] }), read: async () => ({ groups: [] }) });
    const asked = new FakeClient(), older = new FakeClient();
    const a = stream(asked, "default", false, false, false, true), b = stream(older, "default", false);
    await settle(); await settle();
    expect(asked.frames.map(frame => frame.type)).toEqual(["overview", "sudo"]);
    expect(asked.frames[1]).toEqual({ type: "sudo", requests: [] });
    // A watching phone lets askpass wait without a push.
    const out = replies();
    await value.ask({ pid: ASKPASS }, out.respond);
    expect(out.list).toEqual([]);
    expect(asked.frames.at(-1)).toMatchObject({ type: "sudo", requests: [{ command: "killall -HUP mDNSResponder" }] });
    value.answer(value.list()[0].id, { password: "hunter2" });
    expect(asked.frames.at(-1)).toEqual({ type: "sudo", requests: [] });
    expect(JSON.stringify(asked.frames)).not.toContain("hunter2");
    expect(older.frames.map(frame => frame.type)).toEqual(["overview"]);
    a.stop(); b.stop();
    // Closed: no phone left to answer.
    asked.close();
    const after = replies();
    await value.ask({ pid: ASKPASS }, after.respond);
    expect(after.list[0]).toMatchObject({ status: 503 });
  });
});

describe("askpass install", () => {
  let home: string, previous: string | undefined;
  beforeEach(async () => { previous = process.env.PHREN_BRIDGE_HOME; home = await mkdtemp(path.join(tmpdir(), "phren-askpass-")); process.env.PHREN_BRIDGE_HOME = home; });
  afterEach(async () => { if (previous === undefined) delete process.env.PHREN_BRIDGE_HOME; else process.env.PHREN_BRIDGE_HOME = previous; await rm(home, { recursive: true, force: true }); });

  it("writes an owner-only script sudo can run, and launches carry SUDO_ASKPASS only once it exists", async () => {
    expect(askpassEnv()).toEqual({});
    expect(headlessEnv({ harness: "codex" } as never, { PATH: "/bin" })).toEqual({ PATH: "/bin" });
    await installAskpass("/opt/node's/bin/node", path.join(home, "current/bridge-hook.mjs"));
    const script = await readFile(askpassPath(), "utf8");
    expect(script).toBe("#!/bin/sh\n# Installed by Phren Hook: sudo -A asks the phone for the password.\n"
      + "unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH\n"
      + `'/opt/node'\\''s/bin/node' '${path.join(home, "current/bridge-hook.mjs")}' askpass "$@"\n`);
    expect(script).toBe(askpassScript("/opt/node's/bin/node", path.join(home, "current/bridge-hook.mjs")));
    expect((await stat(askpassPath())).mode & 0o777).toBe(0o700);
    expect(askpassEnv()).toEqual({ SUDO_ASKPASS: path.join(home, "askpass") });
    expect(headlessEnv({ harness: "codex" } as never, { PATH: "/bin" })).toEqual({ PATH: "/bin", SUDO_ASKPASS: path.join(home, "askpass") });
    await removeAskpass();
    expect(askpassEnv()).toEqual({});
  });
});
