import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import type { AcpPeer } from "./acp.js";
/** Owner-configured installed command only. No shell, package download or implicit login. */
export function openAcpStdio(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): AcpPeer {
  const child = spawn(command, args, { cwd, env, stdio: "pipe" });
  let sequence = 0, buffer = "", closed = false, stopped = false;
  const decoder = new StringDecoder("utf8");
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  const listeners = new Set<Parameters<AcpPeer["on"]>[0]>();
  const send = (message: unknown) => { if (closed) throw new Error("ACP transport is closed."); child.stdin.write(JSON.stringify(message) + "\n"); };
  const end = () => { closed = true; for (const request of pending.values()) { if (request.timer) clearTimeout(request.timer); request.reject(new Error("ACP transport closed.")); } pending.clear(); };
  child.stdin.on("error", end);
  child.stderr.resume(); child.on("error", end); child.on("exit", end);
  child.stdout.on("data", chunk => {
    buffer += decoder.write(chunk); if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { peer.close(); return; }
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line.trim()) continue;
      let message: any; try { message = JSON.parse(line); } catch { peer.close(); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { peer.close(); return; }
      if (message.method) { for (const listener of listeners) { try { listener(message); } catch { peer.close(); return; } } }
      else if (typeof message.id === "number") { const request = pending.get(message.id); if (!request) continue; pending.delete(message.id); if (request.timer) clearTimeout(request.timer); if (message.error) request.reject(new Error("ACP request rejected.")); else request.resolve(message.result); }
    }
  });
  const peer: AcpPeer = {
    request(method, params, timeoutMs = 10000) { const id = ++sequence; return new Promise((resolve, reject) => { const timer = timeoutMs > 0 ? setTimeout(() => { pending.delete(id); reject(new Error("ACP request timed out.")); }, timeoutMs) : undefined; pending.set(id, { resolve, reject, timer }); try { send({ jsonrpc: "2.0", id, method, params }); } catch (error) { pending.delete(id); if (timer) clearTimeout(timer); reject(error); } }); },
    notify(method, params) { send({ jsonrpc: "2.0", method, params }); },
    respond(id, result) { send({ jsonrpc: "2.0", id, result }); },
    respondError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); },
    on(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { if (stopped) return; stopped = true; end(); child.stdin.end(); child.kill(); },
  };
  return peer;
}
