import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { paneIdentity } from "./herdr.js";
import { object, objects, type Json } from "./protocol.js";
import { transcriptPath } from "./transcripts.js";

const MAX_TAIL_BYTES = 262_144;
const MAX_SESSIONS = 32;
const CONCURRENCY = 4;
const OVERVIEW_BUDGET_MS = 1500;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000 ? value : undefined;
}

/** Use the last response's complete token count, never cumulative session
 * billing or a guessed model limit. A reset/compaction invalidates older usage. */
function codexContext(tail: Buffer, startsAtBeginning: boolean): number | undefined {
  const rows = tail.toString("utf8").split("\n");
  rows.pop(); // An unfinished trailing row is not yet an observation.
  if (!startsAtBeginning) rows.shift();
  for (let i = rows.length - 1; i >= 0; i--) {
    let raw: Json;
    try { raw = object(JSON.parse(rows[i])); } catch { continue; }
    if (raw.type === "compacted") return undefined;
    const payload = object(raw.payload);
    if (raw.type !== "event_msg" || payload.type !== "token_count") continue;
    const info = object(payload.info), usage = object(info.last_token_usage);
    const used = count(usage.total_tokens), limit = count(info.model_context_window);
    if (used === undefined || limit === undefined || limit === 0) return undefined;
    return Math.min(100, used / limit * 100);
  }
  return undefined;
}

/** A bounded metadata cache avoids decoding unchanged transcripts. Reads
 * inspect at most the final 256 KiB, without building the full chat index. */
export class ContextUsageReader {
  private cache = new Map<string, { stat: string; percent: number | undefined }>();

  async read(file: string, session: string): Promise<number | undefined> {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) return undefined;
      const key = `codex:${session}:${file}`;
      const stat = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
      const cached = this.cache.get(key);
      this.cache.delete(key);
      if (cached?.stat === stat) { this.cache.set(key, cached); return cached.percent; }
      const start = Math.max(0, metadata.size - MAX_TAIL_BYTES);
      const tail = Buffer.alloc(metadata.size - start);
      const { bytesRead } = await handle.read(tail, 0, tail.length, start);
      if (bytesRead !== tail.length) return undefined;
      const after = await handle.stat();
      if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs) return undefined;
      const percent = codexContext(tail, start === 0);
      this.cache.set(key, { stat, percent });
      while (this.cache.size > MAX_SESSIONS) this.cache.delete(this.cache.keys().next().value!);
      return percent;
    } finally { await handle.close(); }
  }
}

/** Resolve only exact foreground identities. A tab with multiple agent panes
 * has no single context percentage, and unsupported providers stay unknown. */
export class WorkspaceContextUsage {
  private reader = new ContextUsageReader();
  private active?: Promise<void>;

  async read(server: string, snapshot: Json): Promise<ReadonlyMap<Json, number>> {
    // A timed-out batch may still be draining bounded filesystem/process work.
    // Do not accumulate another batch or apply its observations to a new snapshot.
    if (this.active) return new Map();
    const agentsByTab = new Map<string, Json[]>();
    for (const pane of objects(snapshot.panes)) {
      if (!pane.agent || typeof pane.workspace_id !== "string" || typeof pane.tab_id !== "string") continue;
      const key = JSON.stringify([pane.workspace_id, pane.tab_id]);
      const agents = agentsByTab.get(key) ?? [];
      agents.push(pane); agentsByTab.set(key, agents);
    }
    const candidates: Json[] = [];
    for (const tab of objects(snapshot.tabs)) {
      if (typeof tab.workspace_id !== "string" || typeof tab.tab_id !== "string") continue;
      const agents = agentsByTab.get(JSON.stringify([tab.workspace_id, tab.tab_id]));
      if (agents?.length === 1 && agents[0].agent === "codex") candidates.push(agents[0]);
      if (candidates.length === MAX_SESSIONS) break;
    }
    const result = new Map<Json, number>();
    const sessions = new Map<string, Promise<number | undefined>>();
    let cursor = 0, expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(() => { expired = true; resolve(); }, OVERVIEW_BUDGET_MS);
    });
    const batch = Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, async () => {
      while (!expired && cursor < candidates.length) {
        const pane = candidates[cursor++];
        try {
          const session = await paneIdentity(server, pane);
          if (expired) return;
          if (!session) continue;
          let reading = sessions.get(session);
          if (!reading) {
            reading = transcriptPath("codex", session).then(file => expired ? undefined : this.reader.read(file, session));
            sessions.set(session, reading);
          }
          const percent = await reading;
          if (!expired && percent !== undefined) result.set(pane, percent);
        } catch { /* Unavailable identity or usage must not block the overview. */ }
      }
    })).then(() => {});
    this.active = batch;
    const release = () => { if (this.active === batch) this.active = undefined; };
    void batch.then(release, release);
    try { await Promise.race([batch, deadline]); }
    finally { expired = true; clearTimeout(timer!); }
    // The response owns a snapshot, even when slow lookups finish after it returns.
    return new Map(result);
  }
}
