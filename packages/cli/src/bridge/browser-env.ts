import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
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
