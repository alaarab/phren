import { activateModules as moduleSnapshot } from "../modules/runtime.js";
import { disabledHint } from "../modules/registry.js";
import { defaultPhrenPath } from "../shared.js";
import { connect, type NetConnectOpts } from "node:net";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { BridgeError, object, PROTOCOL, serverName, socketPath, bridgeRoot, atomic, type Json } from "./protocol.js";
import { rpc } from "./herdr.js";
import { launchDirectory } from "./projects.js";

/** Decode the base64url project folder from a `phren-hook v1 shell` command; undefined when it is not a path. */
export function decodeShellDirectory(encoded: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(encoded)) return undefined;
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) return undefined;
  const dir = decoded.toString("utf8");
  return path.isAbsolute(dir) && !/[\x00-\x1f\x7f]/.test(dir) && !dir.includes("\ufffd") ? dir : undefined;
}
export function shellEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith("HERDR_")));
  env.PATH = [path.join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  return env;
}

export async function health(): Promise<Json> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socketPath(), path: "/v1/health", timeout: 2000 }, response => {
      let data = "";
      response.on("data", chunk => { data += chunk.toString(); if (data.length > 65_536) req.destroy(new Error("Invalid helper status")); });
      response.on("end", () => {
        try {
          const value = object(JSON.parse(data));
          if (response.statusCode !== 200 || value.product !== "phren-hook" || value.protocol !== PROTOCOL) throw new Error("Incompatible Phren Hook.");
          resolve(value);
        } catch (error) { reject(error); }
      });
      response.on("error", reject);
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("Phren Hook did not answer."))); req.end();
  });
}

async function pipe(destination: NetConnectOpts, timing?: string): Promise<void> {
  // The gateway's own cost, from process start to the first byte the Hook
  // answers with. A loaded machine makes this large even while it is healthy.
  const started = Date.now() - process.uptime() * 1000;
  await new Promise<void>((resolve, reject) => {
    const socket = connect(destination);
    const stop = () => socket.destroy();
    if (timing) socket.once("data", () => {
      atomic(timing, { ms: Math.round(Date.now() - started), at: new Date().toISOString() }).catch(() => {});
    });
    // The client's EOF is not forwarded as a FIN: node's HTTP server aborts a
    // half-closed connection whose response has not started yet, which
    // dropped the reply to a large upload whenever the SSH client closed its
    // write side right after the body. The Hook closes the socket itself once
    // it has answered (every request is Connection: close), and that close
    // ends this process.
    socket.on("connect", () => { process.stdin.pipe(socket, { end: false }); socket.pipe(process.stdout); });
    socket.on("error", reject);
    socket.on("close", () => {
      process.stdin.unpipe(socket); process.stdin.pause();
      process.stdout.removeListener("error", stop);
      resolve();
    });
    process.stdout.once("error", stop);
  });
}

/** The SSH key is forced to this allowlisted dispatcher. The supplied command is data, never a shell. */
export async function dispatch(command: string): Promise<void> {
  const requireHook = () => {
    if (!moduleSnapshot(defaultPhrenPath(), undefined, true).has("hook")) throw new BridgeError(404, disabledHint("hook"));
  };
  if (command === "phren-hook v1 pipe") { requireHook();
    await pipe({ path: socketPath() }, path.join(bridgeRoot(), "gateway.json"));
    return;
  }
  // SSH port-forwarding also permits Unix sockets, bypassing the callback and
  // Herdr boundaries. Preview bytes instead use this exact loopback command.
  const preview = /^phren-hook v1 web (127\.0\.0\.1|::1) ([1-9][0-9]{0,4})$/.exec(command);
  if (preview && preview[0] === command && Number(preview[2]) <= 65535) {
    requireHook();
    await pipe({ host: preview[1], port: Number(preview[2]) });
    return;
  }
  // Without Herdr: a login shell, or one agent, in a validated project folder
  // on the SSH PTY itself. Nothing persists after the phone disconnects.
  const shell = /^phren-hook v1 shell ([A-Za-z0-9_-]{1,8192})(?: (codex|claude|copilot|opencode))?$/.exec(command);
  if (shell && shell[0] === command) {
    requireHook();
    const raw = decodeShellDirectory(shell[1]);
    if (!raw) throw new BridgeError(403, "The shell folder is not a valid absolute path.");
    const cwd = await launchDirectory(raw);
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Request an SSH terminal first.");
    const login = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : "/bin/sh";
    const [file, args] = shell[2] ? [shell[2], []] : [login, ["-l"]];
    await attach(file, args, { cwd, env: shellEnvironment() }, shell[2] ? `${shell[2]} exited.` : "The shell exited.");
    return;
  }
  const terminal = /^phren-hook v1 terminal ([A-Za-z0-9_.-]{1,100})$/.exec(command);
  if (!terminal || terminal[0] !== command) throw new BridgeError(403, "This SSH key only permits Phren Hook, loopback web previews, project shells, and existing Herdr terminals.");
  requireHook();
  const server = serverName.parse(terminal[1]);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Request an SSH terminal first.");
  // Verify the named server exists; never create a workspace or an agent implicitly.
  await rpc(server, "ping");
  await attach("herdr", ["session", "attach", server], { env: shellEnvironment() }, "The Herdr terminal disconnected.");
}

/** Run one program on the inherited SSH PTY until it exits or the session hangs up. */
async function attach(file: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv }, failure: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: "inherit" });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(failure)));
    const stop = () => child.kill("SIGHUP");
    process.once("SIGHUP", stop); process.once("SIGTERM", stop);
    child.once("exit", () => { process.removeListener("SIGHUP", stop); process.removeListener("SIGTERM", stop); });
  });
}
