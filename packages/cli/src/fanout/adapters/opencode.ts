import type { Adapter } from "./types.js";
import { driveOpencode } from "../opencode-serve.js";
/** `opencode run` rejects every permission ask itself, so a worker runs under
 * `opencode serve` and the launcher drives its session over HTTP. */
export const opencode: Adapter = {
  command: "opencode",
  argv: () => ["serve", "--hostname", "127.0.0.1", "--port", "0"],
  session: event => typeof event.sessionID === "string" && /^ses_[0-9a-z]{1,64}$/i.test(event.sessionID) ? event.sessionID : undefined,
  drive: driveOpencode,
};
