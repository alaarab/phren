import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { bridgeRoot, type Json } from "./protocol.js";

/** Local bounded journal. No prompts, transcript bodies, credentials, or cloud upload. */
export class ActivityJournal {
  private pending = Promise.resolve();
  private previous = new Map<string, string>();
  record(server: string, panes: Json[]): Promise<void> {
    this.pending = this.pending.catch(() => {}).then(async () => {
      const changes: Json[] = [];
      for (const pane of panes) {
        if (!pane.agent) continue;
        const key = `${server}:${pane.pane_id}`;
        const state = JSON.stringify([pane.agent, pane.agent_status, pane.terminal_id]);
        if (this.previous.get(key) === state) continue;
        this.previous.set(key, state);
        changes.push({ at: new Date().toISOString(), source: "herdr", server, workspace: pane.workspace_id,
          tab: pane.tab_id, pane: pane.pane_id, provider: pane.agent, state: pane.agent_status, directory: pane.foreground_cwd || pane.cwd });
      }
      if (!changes.length) return;
      const root = bridgeRoot(), file = path.join(root, "activity.jsonl");
      await mkdir(root, { recursive: true, mode: 0o700 });
      if ((await stat(file).catch(() => null))?.size && (await stat(file)).size > 2_097_152) await rename(file, file + ".previous");
      await appendFile(file, changes.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
      if (this.previous.size > 4096) this.previous.clear();
    });
    return this.pending;
  }
  async recent(): Promise<Json[]> {
    const text = await readFile(path.join(bridgeRoot(), "activity.jsonl"), "utf8").catch(() => "");
    return text.trim().split("\n").slice(-500).flatMap(line => { try { return [JSON.parse(line) as Json]; } catch { return []; } });
  }
}
