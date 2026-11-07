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
function installedBrowserShimPath(): string {
  const installed = path.join(bridgeRoot(), "current/bridge/browser-shim/phren-playwright.cjs");
  return realpathSync(existsSync(installed) ? installed : browserShimPath());
}
export function browserEnv(session: string, existing = process.env.NODE_OPTIONS ?? ""): Record<string, string> {
  const shim = installedBrowserShimPath();
  const requireOption = `--require=${JSON.stringify(shim)}`;
  return { NODE_OPTIONS: `${existing}${existing ? " " : ""}${requireOption}`, PHREN_BROWSER_SOCKET: path.join(bridgeRoot(), "browser.sock"), PHREN_BROWSER_SESSION: session };
}
export function printBrowserEnv(session = process.env.PHREN_BROWSER_SESSION || process.env.HERDR_PANE_ID || process.env.TMUX_PANE || `manual-${process.ppid}`, format: "shell" | "json" | "fish" = "shell"): void {
  const env = browserEnv(session);
  if (format === "json") { console.log(JSON.stringify(env)); return; }
  for (const [key, value] of Object.entries(env)) {
    const quoted = format === "fish" ? "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'" : "'" + value.replace(/'/g, "'\\''") + "'";
    console.log(format === "fish" ? `set -gx ${key} ${quoted};` : `export ${key}=${quoted}`);
  }
  // A comment remains shell-evaluable, including paths containing newlines.
  const bun = `Bun 1.4.2: bun --preload '${installedBrowserShimPath().replace(/'/g, "'\\''")}' run.mjs; also call the shim's initPage({ page }) after newPage(): Bun bypasses automatic interception.`;
  console.log(bun.split("\n").map(line => `# ${line}`).join("\n"));
}

/** Ask sockets are independent of producer sockets; closing one cancels its help request. */
export async function runBrowser(args: string[]): Promise<number> {
  const usage = 'Usage: phren browser env [--session <name>] [--json | --fish] | phren browser ask "<reason>" [--browser <id>] [--timeout <seconds, default 900>]';
  if (args.length === 0 || args.includes("--help")) { console.log(usage + '\nStart Playwright after: eval "$(phren browser env)" (preserves NODE_OPTIONS).\nFish: phren browser env --fish | source\nBun: bun --preload <shim> run.mjs (also call shim.initPage({ page }); see env output).'); return 0; }
  if (args[0] === "env") {
    let session: string | undefined, format: "shell" | "json" | "fish" = "shell";
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--session" && args[i + 1] && !args[i + 1].startsWith("--")) session = args[++i];
      else if ((args[i] === "--json" || args[i] === "--fish") && format === "shell") format = args[i] === "--json" ? "json" : "fish";
      else { console.error(usage); return 1; }
    }
    printBrowserEnv(session, format); return 0;
  }
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
