import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { Computer, OverviewHub } from "./contract.js";
import { closeMasters, sshArgs } from "./hosts.js";
import { createOverviewHub } from "./overview.js";

const exits = vi.hoisted(() => [] as string[][]);
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  execFile(_command: string, args: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) {
    exits.push(args);
    queueMicrotask(() => callback(null, "", ""));
  },
}));

class Socket extends EventEmitter {
  terminate = vi.fn(() => this.emit("close"));
  frame(label: string) {
    this.emit("message", Buffer.from(JSON.stringify({ type: "overview", groups: [{ id: label, label, children: [] }] })));
  }
}
const asWebSocket = (socket: Socket) => socket as unknown as WebSocket;
const controlPath = (args: string[]) => args.find(arg => arg.startsWith("ControlPath="));
let hub: OverviewHub;
let dir: string | undefined;
afterEach(async () => {
  hub?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
  exits.length = 0;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("connection replacement", () => {
  it.each([true, false])("discards the previous server's pending handshake (old resolves first: %s)", async oldFirst => {
    vi.useFakeTimers();
    let receive: (ev: { data: string }) => void = () => {};
    vi.stubGlobal("WebSocket", class {
      addEventListener(type: string, listener: typeof receive) { if (type === "message") receive = listener; }
    });
    vi.stubGlobal("location", { protocol: "http:", host: "desktop" });
    // @ts-expect-error plain browser module without types
    const { connectStore, store } = await import("../ui/shell/store.js");
    connectStore();
    const computer: Computer = { name: "Desk", local: true, server: "old" };
    const pending: ((socket: WebSocket) => void)[] = [];
    hub = createOverviewHub([computer], () => new Promise(resolve => pending.push(resolve)));
    hub.on("change", merged => receive({ data: JSON.stringify({ type: "overview", merged }) }));
    hub.start();
    hub.setComputers([{ ...computer, server: "new" }]);
    const old = new Socket();
    const current = new Socket();
    for (const index of oldFirst ? [0, 1] : [1, 0]) {
      pending[index](asWebSocket(index === 0 ? old : current));
      await Promise.resolve();
    }
    current.frame("new-session");
    old.frame("old-session");
    await vi.advanceTimersByTimeAsync(200);
    expect(store.merged.computers[0].overview.groups[0].id).toBe("new-session");
    expect(old.terminate).toHaveBeenCalledTimes(1);
    hub.stop();
    expect(current.terminate).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === "win32")("closes the original masters and replaces the overview after rotating a key in place", async () => {
    vi.useFakeTimers();
    await mkdir(".scratch", { recursive: true });
    dir = await mkdtemp(path.resolve(".scratch/connection-review-"));
    vi.stubEnv("PHREN_BRIDGE_HOME", dir);
    const keyFile = path.join(dir, "key");
    await writeFile(keyFile, "private A");
    await writeFile(`${keyFile}.pub`, "ssh-ed25519 AAAAKEYA");
    const computer: Computer = { name: "Desk", local: false, address: "box", username: "me", hostKey: "ssh-ed25519 AAAAPIN", keyFile, server: "default" };
    const sockets: Socket[] = [];
    const paths: (string | undefined)[] = [];
    hub = createOverviewHub([computer], async c => {
      paths.push(controlPath(sshArgs(c, "phren-hook v1 pipe")));
      const socket = new Socket();
      sockets.push(socket);
      return asWebSocket(socket);
    });
    hub.start();
    await Promise.resolve();
    sockets[0].frame("key-A-session");
    await writeFile(keyFile, "private B");
    await writeFile(`${keyFile}.pub`, "ssh-ed25519 AAAAKEYB");
    // A relink tears down the previous connection before checking health with B.
    await closeMasters({ ...computer });
    expect(exits.map(controlPath)).toContain(paths[0]);
    const healthPath = controlPath(sshArgs(computer, "phren-hook v1 pipe"));
    expect(healthPath).not.toBe(paths[0]);
    hub.setComputers([{ ...computer }]);
    await Promise.resolve();
    expect(sockets).toHaveLength(2);
    expect(sockets[0].terminate).toHaveBeenCalledTimes(1);
    expect(paths[1]).toBe(healthPath);
    sockets[1].frame("key-B-session");
    expect(hub.current().computers[0].overview?.groups[0].id).toBe("key-B-session");
  });
});
