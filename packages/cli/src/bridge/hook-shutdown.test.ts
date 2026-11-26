import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { hookRequest } from "./client.js";

it.skipIf(process.platform === "win32")("exits cleanly on SIGTERM while a Claude auth probe is running", async () => {
  const root = await mkdtemp("/tmp/phren-shutdown-");
  const bridge = path.join(root, "bridge"), socket = path.join(bridge, "hook.sock");
  const bundle = path.resolve(process.env.PHREN_TEST_HOOK_BUNDLE || "packages/cli/dist/bridge-hook.mjs");
  let probePid: number | undefined;
  const ready = createServer(client => {
    let data = "";
    client.on("data", chunk => { data += chunk; });
    client.on("end", () => { probePid = Number(data); ready.emit("probe"); });
  });
  const readySocket = path.join(root, "probe.sock");
  const listening = once(ready, "listening");
  ready.listen(readySocket);
  await listening;
  await writeFile(path.join(root, "claude"), `#!${process.execPath}
if (process.argv[2] === "--version") {
  console.log("2.1.279");
} else if (process.argv.slice(2).join(" ") === "auth status --json") {
  process.on("SIGTERM", () => {});
  const socket = require("node:net").connect(${JSON.stringify(readySocket)});
  socket.on("connect", () => socket.end(String(process.pid)));
  setInterval(() => {}, 60_000);
}
`, { mode: 0o700 });
  const hook = spawn(process.execPath, [bundle, "serve"], {
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), PHREN_PATH: path.join(root, "store"),
      PHREN_BRIDGE_HOME: bridge, PHREN_HERDR_HOME: path.join(root, "herdr"), PATH: root },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  hook.stderr!.on("data", chunk => { log += chunk; });
  try {
    await vi.waitFor(() => hookRequest("/v1/health", undefined, { socketPath: socket }, 500), { timeout: 8_000 });
    const started = once(ready, "probe", { signal: AbortSignal.timeout(5_000) });
    void hookRequest("/v1/harnesses", undefined, { socketPath: socket }).catch(() => {});
    await started;
    expect(probePid).toBeGreaterThan(1);
    expect(process.kill(probePid!, 0)).toBe(true);

    const exited = once(hook, "exit", { signal: AbortSignal.timeout(1_500) });
    expect(hook.kill("SIGTERM")).toBe(true);
    expect(await exited, log).toEqual([0, null]);
    expect(() => process.kill(probePid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    probePid = undefined;
    await expect(stat(socket)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (probePid && probePid > 1) {
      try { process.kill(probePid, "SIGKILL"); } catch { /* The Hook already reaped it. */ }
    }
    if (hook.exitCode === null && hook.signalCode === null) {
      const exited = once(hook, "exit");
      hook.kill("SIGKILL");
      await exited;
    }
    await new Promise<void>(resolve => ready.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 18_000);
