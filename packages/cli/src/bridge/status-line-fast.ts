// Claude Code runs its status line command on every refresh, from every
// session. Loading the Hook bundle for each one cost about a second of CPU, and
// installs under a different node wrapped the previous wrapper, so one refresh
// ran a chain of bundles. Install writes this small script into each version's
// folder beside the bundle: it posts the status line's input to the running
// Hook, which records the usage, and runs the owner's own status line, if any.
//
// It must stay dependency-free. When no Hook answers, nothing is recorded: the
// Hook is what serves the usage, and the next refresh after it starts records it.
import path from "node:path";

/** The script's file name in a version's folder, beside `bridge-hook.mjs`. */
export const FAST_STATUS_LINE_FILE = "claude-statusline.mjs";
export const fastStatusLinePath = (versionDir: string) => path.join(versionDir, FAST_STATUS_LINE_FILE);

/** The owner's status line under any number of Phren wrappers: what a status line that is Phren's wraps,
 * down to one that is not. `null` when the innermost wrapped none; a value that is not Phren's is returned as is.
 * Phren's is the quoted node, the quoted bundle or forwarder (whichever node and Hook folder it named),
 * `usage-statusline` and the wrapped status line as base64. Self-contained: the forwarder embeds its source. */
export function unwrapStatusLine(value: unknown): unknown {
  const phren = /^'(?:[^']|'\\'')*' '(?:[^']|'\\'')*\/(?:bridge-hook|claude-statusline)\.mjs' usage-statusline ([A-Za-z0-9+/=]{1,32768})$/;
  for (let depth = 0; depth < 16; depth++) {
    const command = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).command : undefined;
    const match = typeof command === "string" ? phren.exec(command) : null;
    if (!match) return value;
    value = JSON.parse(Buffer.from(match[1], "base64").toString());
  }
  throw new Error("Invalid Phren status line");
}

export const FAST_STATUS_LINE_SOURCE = `// Installed by Phren Hook: Claude Code's status line, reported to the running Hook.
import { spawn } from "node:child_process";
import { request } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
const env = process.env, encoded = process.argv[3] ?? "";
const unwrapStatusLine = ${unwrapStatusLine.toString()};
if (process.argv[2] === "usage-statusline" && /^[A-Za-z0-9+/=]{1,32768}$/.test(encoded)) {
  let input = "", oversized = false;
  for await (const chunk of process.stdin) { input += chunk.toString(); if (input.length > 262_144) { oversized = true; break; } }
  const data = oversized ? undefined : JSON.stringify({ configDir: env.CLAUDE_CONFIG_DIR, input });
  const socketPath = path.join(env.PHREN_BRIDGE_HOME || path.join(homedir(), ".local/share/phren/bridge"), "agent.sock");
  const reported = data === undefined ? undefined : new Promise(resolve => {
    const req = request({ socketPath, path: "/usage-statusline", method: "POST", timeout: 2_000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, res => { res.resume(); res.on("end", resolve); res.on("error", resolve); });
    req.on("error", resolve); req.on("timeout", () => { req.destroy(); resolve(); }); req.end(data);
  });
  let previous;
  try { previous = unwrapStatusLine(JSON.parse(Buffer.from(encoded, "base64").toString())); } catch { /* Nothing of the owner's to show. */ }
  // The owner's own status line, run just as Claude ran it before the Hook was installed.
  const shown = previous && typeof previous.command === "string" ? new Promise(resolve => {
    const child = spawn("/bin/sh", ["-c", previous.command], { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", resolve); child.on("exit", resolve);
    child.stdin.on("error", () => {}); child.stdin.end(input);
  }) : undefined;
  await Promise.all([reported, shown]);
}
`;
