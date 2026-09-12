import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, createServer, type AddressInfo } from "node:net";
import { request } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { dispatch } from "./transport.js";
import { forcedCommand, upgradeKeys } from "./install.js";

const hookBundle = path.resolve(process.env.PHREN_TEST_HOOK_BUNDLE || "packages/cli/dist/bridge-hook.mjs");

describe("Phren device key restrictions", () => {
  it("removes generic forwarding from recognized legacy and current keys", () => {
    for (const command of ['command="/usr/bin/false"', 'command="python3 ~/.local/share/phren/chat-progress.py"', forcedCommand]) {
      const before = `restrict,port-forwarding,permitopen="127.0.0.1:*",permitopen="[::1]:*",${command} ssh-ed25519 AAAA phren-iphone\n`;
      const after = `restrict,pty,${forcedCommand} ssh-ed25519 AAAA phren-iphone\n`;
      expect(upgradeKeys(before)).toEqual({ text: after, changed: 1 });
      expect(upgradeKeys(after)).toEqual({ text: after, changed: 0 });
    }
  });

  it("preserves quoted option contents and unrelated keys and policies", () => {
    const constraint = 'from="10.0.0.0/8,192.168.0.0/16",environment="LABEL=keep,port-forwarding,permitopen=\\"127.0.0.1:*\\""';
    const before = `restrict,${constraint},port-forwarding,permitopen="127.0.0.1:*",${forcedCommand} ssh-ed25519 AAAA phren-iphone\n`;
    const personal = before.replace("phren-iphone", "personal");
    const custom = before.replace(forcedCommand, 'command="/custom/policy"');
    expect(upgradeKeys(before + personal + custom)).toEqual({
      text: `restrict,pty,${constraint},${forcedCommand} ssh-ed25519 AAAA phren-iphone\n` + personal + custom,
      changed: 1,
    });
  });

  it("handles case-insensitive forwarding flags and OpenSSH quoted escapes", () => {
    // OpenSSH escapes double quotes, including after a literal backslash.
    const constraint = 'environment="LABEL=backslash' + "\\".repeat(2) + '",port-forwarding,keep"';
    const before = `restrict,${constraint},PORT-FORWARDING,PermitOpen="127.0.0.1:*",${forcedCommand} ssh-ed25519 AAAA phren-iphone\n`;
    expect(upgradeKeys(before)).toEqual({
      text: `restrict,pty,${constraint},${forcedCommand} ssh-ed25519 AAAA phren-iphone\n`, changed: 1,
    });
  });
});

describe("Phren preview dispatcher", () => {
  it.each([
    "phren-hook v1 web 127.0.0.1 0", "phren-hook v1 web 127.0.0.1 65536", "phren-hook v1 web 127.0.0.1 -1",
    "phren-hook v1 web 127.0.0.1 1.5", "phren-hook v1 web 127.0.0.1 1e3", "phren-hook v1 web 127.0.0.1 00080",
    "phren-hook v1 web localhost 80", "phren-hook v1 web 0.0.0.0 80", "phren-hook v1 web 192.0.2.1 80",
    "phren-hook v1 web /tmp/agent.sock 80", "phren-hook v1 web 127.0.0.1 /tmp/agent.sock",
    "phren-hook v1 web 127.0.0.1 80; id", "phren-hook v1 web 127.0.0.1 80\n", "phren-hook v1 web 127.0.0.1 80 extra",
    "phren-hook v1 terminal default\n",
  ])("rejects destination or command injection: %j", async command => {
    await expect(dispatch(command)).rejects.toMatchObject({ status: 403 });
  });

  it.each(["127.0.0.1", "::1"])("relays preview bytes only to the selected %s TCP port", async host => {
    const server = createServer(socket => socket.on("data", bytes => socket.write(bytes)));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
    const child = spawn(process.execPath, [hookBundle, "ssh"], {
      env: { ...process.env, SSH_ORIGINAL_COMMAND: `phren-hook v1 web ${host} ${(server.address() as AddressInfo).port}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = ""; const output: Buffer[] = [];
    child.stdout.on("data", bytes => output.push(bytes)); child.stderr.on("data", bytes => { stderr += bytes; });
    try {
      const exited = once(child, "exit");
      const payload = Buffer.from("GET /fixture HTTP/1.1\r\nHost: localhost\r\n\r\n\0binary");
      child.stdin.end(payload);
      expect(await exited, stderr).toEqual([0, null]);
      expect(Buffer.concat(output)).toEqual(payload);
    } finally {
      if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe.skipIf(process.platform === "win32")("Phren Hook malformed WebSocket isolation", () => {
  let root: string, hook: ChildProcess, stderr: string;
  const socketPath = () => path.join(root, "hook.sock");

  function health(): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: socketPath(), path: "/v1/health", timeout: 1000 }, res => {
        res.resume(); res.once("end", () => resolve(res.statusCode!));
      });
      req.once("error", reject); req.once("timeout", () => req.destroy(new Error("Health timed out"))); req.end();
    });
  }

  beforeEach(async () => {
    // Keep Unix socket paths below Darwin's 104-byte limit.
    root = await mkdtemp("/tmp/phren-ws-"); stderr = "";
    hook = spawn(process.execPath, [hookBundle, "serve"], {
      env: { ...process.env, PHREN_BRIDGE_HOME: root, PHREN_HERDR_HOME: path.join(root, "herdr") },
      stdio: ["ignore", "ignore", "pipe"],
    });
    hook.stderr!.on("data", bytes => { stderr += bytes; });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { ready = await health() === 200; } catch { /* Service startup. */ }
      if (ready || hook.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(ready, stderr).toBe(true);
  });

  afterEach(async () => {
    if (hook && hook.exitCode === null) { hook.kill("SIGTERM"); await once(hook, "exit"); }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(["/v1/transcripts", "/v1/status"])("rejects invalid targets and frames on %s without killing the service", async route => {
    // A raw SSH-pipe client can send the upgrade and a bad frame together,
    // before the server has rejected the missing conversation parameters.
    const socket = connect(socketPath());
    socket.on("error", () => {}); socket.resume();
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    await once(socket, "connect");
    socket.end(Buffer.concat([
      Buffer.from(`GET ${route} HTTP/1.1\r\nHost: phren.local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`),
      Buffer.from([0x81, 0x00]), // Client frames must be masked.
    ]));
    await closed;
    const status = await health().catch(() => 0);
    expect(status, stderr).toBe(200);
    expect(hook.exitCode, stderr).toBeNull();
  });
});
