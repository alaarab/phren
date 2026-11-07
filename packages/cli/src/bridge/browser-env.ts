import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { connect } from "node:net";
import { BROWSER_ID, BrowserMessageReader, browserWire } from "./browser-protocol.js";
import { bridgeRoot } from "./protocol.js";

export function browserShimPath(): string {
  // Normal tsc modules and the standalone bridge-hook.mjs bundle.
  const local = fileURLToPath(new URL("./browser-shim/phren-playwright.cjs", import.meta.url));
  return existsSync(local) ? local : fileURLToPath(new URL("./bridge/browser-shim/phren-playwright.cjs", import.meta.url));
}
export function browserEnv(session: string, existing = process.env.NODE_OPTIONS ?? ""): Record<string, string> {
  const installed = path.join(bridgeRoot(), "current/bridge/browser-shim/phren-playwright.cjs");
  const shim = realpathSync(existsSync(installed) ? installed : browserShimPath());
  const requireOption = `--require=${JSON.stringify(shim)}`;
  return { NODE_OPTIONS: `${existing}${existing ? " " : ""}${requireOption}`, PHREN_BROWSER_SOCKET: path.join(bridgeRoot(), "browser.sock"), PHREN_BROWSER_SESSION: session };
}
export function printBrowserEnv(session = process.env.PHREN_BROWSER_SESSION ?? process.env.HERDR_PANE_ID ?? process.env.TMUX_PANE ?? "shell"): void {
  for (const [key, value] of Object.entries(browserEnv(session))) console.log(`export ${key}='${value.replace(/'/g, "'\\''")}'`);
}

/** Ask sockets are independent of producer sockets; closing one cancels its help request. */
export async function runBrowser(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "env") { printBrowserEnv(); return 0; }
  const usage = 'Usage: phren browser env | phren browser ask "<reason>" [--browser <id>] [--timeout <seconds, default 900>]';
  if (args.length === 0 || args.includes("--help")) { console.log(usage); return 0; }
  let browserId: string | undefined, timeout = 900;
  const reason = args[1];
  if (args[0] !== "ask" || !reason?.trim() || reason.length > 16_384) { console.error(usage); return 1; }
  for (let i = 2; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value) { console.error(usage); return 1; }
    if (args[i] === "--browser" && BROWSER_ID.test(value)) browserId = value;
    else if (args[i] === "--timeout" && Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 2_147_483) timeout = Number(value);
    else { console.error(usage); return 1; }
  }
  return new Promise(resolve => {
    const socket = connect(process.env.PHREN_BROWSER_SOCKET || path.join(bridgeRoot(), "browser.sock"));
    const reader = new BrowserMessageReader();
    let finished = false;
    const finish = (outcome: string) => {
      if (finished) return; finished = true;
      clearTimeout(timer); process.off("SIGINT", interrupt); socket.destroy();
      console.log(`Browser help: ${outcome}`); resolve(outcome === "done" ? 0 : 1);
    };
    const interrupt = () => finish("cancelled");
    const timer = setTimeout(() => finish("timeout"), timeout * 1000 + 1000);
    process.once("SIGINT", interrupt);
    socket.on("connect", () => socket.write(browserWire(0x05, { browserId, session: process.env.PHREN_BROWSER_SESSION, reason, timeout })));
    socket.on("data", (chunk: Buffer) => {
      try { for (const message of reader.push(chunk)) if (message.type === 0x13) finish(message.data.outcome); }
      catch { finish("connection-error"); }
    });
    socket.on("error", () => finish("connection-error"));
    socket.on("close", () => finish("connection-closed"));
  });
}
