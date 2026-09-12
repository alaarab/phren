import { connect, type NetConnectOpts } from "node:net";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { BridgeError, object, PROTOCOL, serverName, socketPath, type Json } from "./protocol.js";
import { rpc } from "./herdr.js";

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

async function pipe(destination: NetConnectOpts): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(destination);
    const end = () => socket.end();
    const stop = () => socket.destroy();
    socket.on("connect", () => { process.stdin.pipe(socket); socket.pipe(process.stdout); });
    socket.on("error", reject);
    socket.on("close", () => {
      process.stdin.unpipe(socket); process.stdin.pause();
      process.stdin.removeListener("end", end); process.stdout.removeListener("error", stop);
      resolve();
    });
    process.stdin.once("end", end); process.stdout.once("error", stop);
  });
}

/** The SSH key is forced to this allowlisted dispatcher. The supplied command is data, never a shell. */
export async function dispatch(command: string): Promise<void> {
  if (command === "phren-hook v1 pipe") {
    await pipe({ path: socketPath() });
    return;
  }
  // SSH port-forwarding also permits Unix sockets, bypassing the callback and
  // Herdr boundaries. Preview bytes instead use this exact loopback command.
  const preview = /^phren-hook v1 web (127\.0\.0\.1|::1) ([1-9][0-9]{0,4})$/.exec(command);
  if (preview && preview[0] === command && Number(preview[2]) <= 65535) {
    await pipe({ host: preview[1], port: Number(preview[2]) });
    return;
  }
  const terminal = /^phren-hook v1 terminal ([A-Za-z0-9_.-]{1,100})$/.exec(command);
  if (!terminal || terminal[0] !== command) throw new BridgeError(403, "This SSH key only permits Phren Hook, loopback web previews, and existing Herdr terminals.");
  const server = serverName.parse(terminal[1]);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Request an SSH terminal first.");
  // Verify the named server exists; never create a workspace or an agent implicitly.
  await rpc(server, "ping");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")));
  env.PATH = [path.join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("herdr", ["session", "attach", server], { env, stdio: "inherit" });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("The Herdr terminal disconnected.")));
    const stop = () => child.kill("SIGHUP");
    process.once("SIGHUP", stop); process.once("SIGTERM", stop);
    child.once("exit", () => { process.removeListener("SIGHUP", stop); process.removeListener("SIGTERM", stop); });
  });
}
