import * as path from "node:path";
import { uuid, type Adapter } from "./types.js";
export const codex: Adapter = {
  command: "codex",
  argv: o => ["exec", ...(o.resume ? ["resume"] : []), "--json",
    ...(!o.resume ? ["--sandbox", o.review ? "read-only" : "workspace-write", "-C", o.worktree] : []),
    "-o", path.join(o.job, "final.txt"), ...(o.model ? ["-m", o.model] : []), ...(o.extra ?? []), ...(o.resume ? [o.resume] : []), "-"],
  session: event => event.type === "thread.started" ? uuid(event.thread_id) : undefined,
};
