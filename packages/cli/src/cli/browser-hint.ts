import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";
import { bridgeRoot } from "../bridge/protocol.js";
import { sessionMarker } from "../shared.js";

/** Claim the notice atomically: parallel prompt hooks share the session marker. */
export function browserHint(phrenPath: string, prompt: string, session: string | undefined, proactivity: string): string | undefined {
  if (!session || proactivity === "low" || proactivity === "off" || process.env.PHREN_PROACTIVITY === "off"
    || process.env.PHREN_BROWSER_SOCKET || process.env.PHREN_BROWSER_WATCH === "0"
    || !/\b(?:playwright|browser|ui\s+walk(?:through)?|screenshots?)\b/i.test(prompt)
    || !existsSync(path.join(bridgeRoot(), "browser.sock"))) return undefined;
  try {
    const key = createHash("sha256").update(session).digest("hex");
    closeSync(openSync(sessionMarker(phrenPath, `browser-hint-${key}`), "wx", 0o600));
  } catch { return undefined; }
  return 'To let the owner watch this browser in Phren, start Playwright after: eval "$(phren browser env)"'
    + (/\bbun\b/i.test(prompt) ? "; Bun: use --preload <shim> and shim.initPage({ page }); see phren browser env." : "");
}
