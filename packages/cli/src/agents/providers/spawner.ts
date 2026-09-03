/**
 * Agents spawned by phren-agent's own multi-agent mode.
 *
 * The spawner runs in a different process from the shell, so it publishes each
 * agent as a small JSON file under `.runtime/agents/` and removes it on exit.
 * That makes phren's own agents visible in the graph on the same footing as
 * any other host's, and gives the provider contract a second real
 * implementation rather than a speculative one.
 */

import * as fs from "fs";
import * as path from "path";
import { runtimeFile } from "../../shared.js";
import { debugLog } from "../../shared.js";
import { errorMessage } from "../../utils.js";
import { isAgentRecord, type AgentProvider, type AgentRecord } from "../types.js";

/** Where a spawner publishes its live agents. */
export function agentsRuntimeDir(phrenPath: string): string {
  return runtimeFile(phrenPath, "agents");
}

/** Records older than this are treated as leaked by a process that died badly. */
const STALE_MS = 5 * 60_000;

export function createSpawnerProvider(phrenPath: string, now: () => number = Date.now): AgentProvider {
  const dir = agentsRuntimeDir(phrenPath);
  return {
    name: "phren-agent",
    available: () => {
      try { return fs.existsSync(dir); } catch { return false; }
    },
    list() {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
      } catch {
        return [];
      }
      const out: AgentRecord[] = [];
      for (const entry of entries) {
        const file = path.join(dir, entry);
        try {
          const stat = fs.statSync(file);
          if (now() - stat.mtimeMs > STALE_MS) continue;
          const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
          const records = Array.isArray(parsed) ? parsed : [parsed];
          for (const record of records) {
            if (isAgentRecord(record)) out.push({ ...record, provider: "phren-agent" });
          }
        } catch (err: unknown) {
          debugLog(`spawner provider: ${entry}: ${errorMessage(err)}`);
        }
      }
      return out;
    },
  };
}
