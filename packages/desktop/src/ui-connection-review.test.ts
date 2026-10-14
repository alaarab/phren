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
  it.skipIf(process.platform === "win32")("isolates valid host pins that collided in the old 32-bit master tag", async () => {
    await mkdir(".scratch", { recursive: true });
    dir = await mkdtemp(path.resolve(".scratch/connection-review-"));
    vi.stubEnv("PHREN_BRIDGE_HOME", dir);
    const keyFile = path.join(dir, "key");
    await writeFile(keyFile, "private A");
    await writeFile(`${keyFile}.pub`, "ssh-ed25519 AAAAKEYA");
    // These Ed25519 pins produced the same old tag (244974d2) for me@box:22.
    const pins = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEmZ/9nH460qtQZpDqe9d+nclY8GdVjn5dIypT+S4vsO",
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIFbJDcS9BhMrv6Bddn75YPB/sj4hhHGhIvCH/HKDxdZ",
    ];
    const computer: Computer = { name: "Desk", local: false, address: "box", username: "me", keyFile, hostKey: pins[0], server: "default" };
    const original = controlPath(sshArgs(computer, "x"))!;
    expect(controlPath(sshArgs({ ...computer, hostKey: pins[1] }, "x"))).not.toBe(original);
    // OpenSSH appends a 17-byte temporary suffix while creating the socket.
    expect(Buffer.byteLength(original.slice("ControlPath=".length)) + 17).toBeLessThan(104);
  });

  it("ignores frames from an attached socket after relinking the same name", async () => {
    vi.useFakeTimers();
    let receive: (ev: { data: string }) => void = () => {};
    vi.stubGlobal("WebSocket", class {
      addEventListener(type: string, listener: typeof receive) { if (type === "message") receive = listener; }
    });
    vi.stubGlobal("location", { protocol: "http:", host: "desktop" });
    // @ts-expect-error plain browser module without types
    const { connectStore, store } = await import("../ui/shell/store.js");
    connectStore();
    const old = new Socket();
    const current = new Socket();
    const computer: Computer = { name: "Desk", local: true, server: "old" };
    hub = createOverviewHub([computer], async c => asWebSocket(c.server === "old" ? old : current));
    hub.on("change", merged => receive({ data: JSON.stringify({ type: "overview", merged }) }));
    hub.start();
    await Promise.resolve();
    old.frame("old-session");
    hub.setComputers([{ ...computer, server: "new" }]);
    await Promise.resolve();
    current.frame("new-session");
    const phren = { version: "0.3.45", capabilities: { fileWrite: true } };
    current.emit("message", Buffer.from(JSON.stringify({ type: "heartbeat", phren })));
    current.emit("message", Buffer.from(JSON.stringify({ type: "resources", resources: { load: 1 } })));
    old.emit("message", Buffer.from(JSON.stringify({ type: "heartbeat", phren: { version: "0.3.1", capabilities: {} } })));
    old.emit("message", Buffer.from(JSON.stringify({ type: "resources", resources: { load: 99 } })));
    await vi.advanceTimersByTimeAsync(200);
    expect(store.merged.computers[0].overview.phren).toEqual(phren);
    expect(store.merged.computers[0].resources).toEqual({ load: 1 });
    old.frame("old-session");
    await vi.advanceTimersByTimeAsync(200);
    expect(store.merged.computers[0].overview.groups[0].id).toBe("new-session");
  });

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

  it.skipIf(process.platform === "win32")("closes the original masters and replaces the overview after rotating a private key with a stale sidecar", async () => {
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
