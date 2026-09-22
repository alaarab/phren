import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectGateway, gatewayScript, type GatewayKind } from "./install.js";

// A forwarder fixture: connect to the Unix socket named in any argument,
// whether it arrives as `UNIX-CONNECT:/path` (socat) or `/path` (nc -U).
const forwarder = `#!${process.execPath}
const net = require('node:net');
const socket = process.argv.slice(2).map(a => a.replace(/^UNIX-CONNECT:/, '')).find(a => a.startsWith('/'));
if (!socket) process.exit(2);
const s = net.connect(socket);
process.stdin.pipe(s); s.pipe(process.stdout);
s.on('error', () => process.exit(1));
`;
// The node gateway fallback just relays bytes; the test only needs that shape.
const relay = `#!${process.execPath}
process.stdin.pipe(process.stdout);
`;

describe("Phren SSH gateway", () => {
  let root: string, bin: string, socket: string, timing: string, server: Server;

  beforeEach(async () => {
    root = await mkdtemp("/tmp/phren-gateway-");
    bin = path.join(root, "bin"); await mkdir(bin);
    socket = path.join(root, "hook.sock"); timing = path.join(root, "gateway.json");
    server = createServer(connection => connection.pipe(connection));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  async function fake(name: string, source: string): Promise<void> {
    const file = path.join(bin, name);
    await writeFile(file, source, { mode: 0o700 }); await chmod(file, 0o700);
  }

  async function run(gateway: GatewayKind, command: string): Promise<string> {
    const dispatch = path.join(root, "dispatch");
    await writeFile(dispatch, gatewayScript(gateway, {
      root, herdr: root, store: root, profile: "default", node: path.join(bin, "node"),
      bundle: path.join(root, "bundle.mjs"), socket, timing,
    }), { mode: 0o700 });
    const child = spawn("/bin/sh", [dispatch], {
      env: { PATH: `${bin}:/bin:/usr/bin`, SSH_ORIGINAL_COMMAND: command }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", errors = "";
    child.stdout.on("data", bytes => { output += bytes; });
    child.stderr.on("data", bytes => { errors += bytes; });
    child.stdin.end("ping");
    const [code] = await once(child, "exit");
    expect(code, errors).toBe(0);
    return output;
  }

  it("detects socat first, then an nc that supports -U, then node", async () => {
    expect(await detectGateway({ PATH: bin })).toBe("node");
    await fake("nc", `#!${process.execPath}\nprocess.stdout.write("usage: nc -U\\n");\n`);
    expect(await detectGateway({ PATH: bin })).toBe("nc");
    await fake("socat", `#!${process.execPath}\nprocess.stdout.write("socat version 1.8\\n");\n`);
    expect(await detectGateway({ PATH: bin })).toBe("socat");
  });

  it("relays the phone's pipe through socat when it is available", async () => {
    await fake("socat", forwarder); await fake("node", relay);
    await writeFile(timing, '{"ms":9999}');
    expect(await run("socat", "phren-hook v1 pipe")).toBe("ping");
    // The fast path clears the node gateway's sample so health never reports it.
    await expect(readFile(timing, "utf8")).rejects.toThrow();
  });

  it("relays the phone's pipe through nc -U when socat is absent", async () => {
    await fake("nc", forwarder); await fake("node", relay);
    expect(await run("nc", "phren-hook v1 pipe")).toBe("ping");
  });

  it("falls back to the node gateway for every other SSH command", async () => {
    await fake("socat", forwarder); await fake("node", relay);
    expect(await run("socat", "phren-hook v1 shell L3RtcA==")).toBe("ping");
  });

  it("keeps the node gateway as the fallback when no forwarder was detected", async () => {
    await fake("node", relay);
    expect(await run("node", "phren-hook v1 pipe")).toBe("ping");
  });
});
