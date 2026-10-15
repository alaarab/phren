// Quota preferences live beside desktop.toml, independent of the daemon's port.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface QuotaState {
  settings: { on: boolean; threshold: number };
  suppressed: string[];
  seen: string[];
}
interface QuotaUpdate { settings?: Partial<QuotaState["settings"]>; suppress?: string; markSeen?: string; unmarkSeen?: string }
const SEEN_LIMIT = 512;
const configFile = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "phren", "desktop-quota.json");
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string" && v.length <= 4096))] : [];

export async function loadQuotaConfig(): Promise<QuotaState> {
  try {
    const value = JSON.parse(await readFile(configFile(), "utf8"));
    return {
      settings: { on: value.settings?.on !== false, threshold: Number.isInteger(value.settings?.threshold) && value.settings.threshold >= 50 && value.settings.threshold <= 99 ? value.settings.threshold : 90 },
      suppressed: strings(value.suppressed), seen: strings(value.seen).slice(-SEEN_LIMIT),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { settings: { on: true, threshold: 90 }, suppressed: [], seen: [] };
  }
}

let writes: Promise<unknown> = Promise.resolve();
/** Merge operations inside the write queue so concurrent updates retain each other. */
export function updateQuotaConfig(input: unknown): Promise<QuotaState> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid quota update");
  const update = input as QuotaUpdate;
  if (Object.keys(update).some((key) => !["settings", "suppress", "markSeen", "unmarkSeen"].includes(key))) throw new Error("Invalid quota update");
  for (const key of ["suppress", "markSeen", "unmarkSeen"] as const) {
    if (update[key] !== undefined && (typeof update[key] !== "string" || !update[key].length || update[key].length > 4096)) throw new Error("Invalid quota token");
  }
  if (update.settings !== undefined) {
    const s = update.settings;
    if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).some((key) => !["on", "threshold"].includes(key))
      || s.on !== undefined && typeof s.on !== "boolean"
      || s.threshold !== undefined && (!Number.isInteger(s.threshold) || s.threshold < 50 || s.threshold > 99)) throw new Error("Invalid quota settings");
  }
  const run = writes.then(async () => {
    const state = await loadQuotaConfig();
    Object.assign(state.settings, update.settings);
    if (update.suppress) state.suppressed = [...new Set([...state.suppressed, update.suppress])];
    if (update.markSeen) state.seen = [...state.seen.filter((token) => token !== update.markSeen), update.markSeen].slice(-SEEN_LIMIT);
    if (update.unmarkSeen) state.seen = state.seen.filter((token) => token !== update.unmarkSeen);
    const file = configFile(), temporary = `${file}.${randomUUID()}.tmp`;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    return state;
  });
  writes = run.catch(() => {});
  return run;
}
