import type { Adapter } from "./types.js";
export const opencode: Adapter = {
  command: "opencode",
  argv: o => ["run", "--format", "json", "--dir", o.worktree, "--model", o.model, "--agent", o.review ? "plan" : "build",
    ...(o.variant ? ["--variant", o.variant] : []), ...(o.resume ? ["--session", o.resume] : []), ...(o.extra ?? [])],
  session: event => typeof event.sessionID === "string" && /^ses_[0-9a-z]{1,64}$/i.test(event.sessionID) ? event.sessionID : undefined,
};
