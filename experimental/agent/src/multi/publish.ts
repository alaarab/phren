/**
 * Publish this process's agents so phren can see them.
 *
 * The phren shell runs in a different process, so the spawner writes its live
 * agents to `<store>/.runtime/agents/<pid>.json` and removes the file on exit.
 * phren's agents overlay reads that directory, which is what lets a graph open
 * in one terminal show the agents this process is running in another.
 *
 * Entirely best-effort: publishing is a courtesy to another tool, and must
 * never interfere with running agents.
 */

import * as fs from "fs";
import * as path from "path";
import type { AgentEntry, AgentStatus } from "./types.js";

/** phren's vocabulary, which is narrower than the spawner's. */
function toPhrenStatus(status: AgentStatus): string {
  switch (status) {
    case "running":
    case "starting":
      return "working";
    case "idle":
      return "idle";
    case "error":
      return "error";
    default:
      return "done";
  }
}

export interface AgentPublisher {
  publish(agents: AgentEntry[]): void;
  stop(): void;
}

/** No-op publisher, for when there is no phren store to publish into. */
const INERT: AgentPublisher = { publish: () => {}, stop: () => {} };

export function createAgentPublisher(phrenPath: string | undefined, pid = process.pid): AgentPublisher {
  if (!phrenPath) return INERT;
  const dir = path.join(phrenPath, ".runtime", "agents");
  const file = path.join(dir, `${pid}.json`);
  let stopped = false;

  const remove = (): void => {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  };

  const publisher: AgentPublisher = {
    publish(agents) {
      if (stopped) return;
      try {
        fs.mkdirSync(dir, { recursive: true });
        const records = agents.map((agent) => ({
          id: `${pid}:${agent.id}`,
          label: agent.displayName || agent.task.slice(0, 60),
          cwd: agent.cwd ?? process.cwd(),
          status: toPhrenStatus(agent.status),
          kind: "phren-agent",
        }));
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(records));
        fs.renameSync(tmp, file);
      } catch { /* best effort: never break an agent to publish it */ }
    },
    stop() {
      stopped = true;
      remove();
    },
  };

  // A crash still leaves the file behind, which is why the reader treats
  // anything it has not seen touched for a few minutes as gone.
  process.once("exit", remove);
  return publisher;
}
