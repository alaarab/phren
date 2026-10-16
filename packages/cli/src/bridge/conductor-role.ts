import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { conductorOriginChanged } from "./dispatch-origins.js";
import { isConductorName, paneAgentName } from "./herdr.js";
import { atomicInPrivateDir, BridgeError, bridgeRoot, id, type Json, objects, provider, serverName, targetSchema } from "./protocol.js";

/**
 * Which pane is this computer's conductor, as the Hook keeps it
 * (docs/conductor-sets.md). The role follows the pane: server, pane id and
 * terminal id. When the agent in that pane restarts or logs in again, the
 * role stays and the new session is recorded. The Herdr agent name or tmux
 * `@phren_agent` is only a label, read once to migrate a conductor that
 * predates this file.
 */

const recordSchema = z.object({
  server: serverName, pane: id, terminal: z.string().max(200).optional(), workspace: id.optional(), tab: id.optional(),
  source: provider.optional(), session: z.string().max(200).optional(),
  since: z.string().datetime(), by: z.enum(["launch", "owner", "migrated"]),
});
export type ConductorRecord = z.infer<typeof recordSchema>;
/** A cleared name keeps its time (`name: null`), so an older name arriving later does not return. */
const setNameSchema = z.object({ name: z.string().min(1).max(60).nullable(), namedAt: z.string().datetime() });
export type SetName = z.infer<typeof setNameSchema>;
/** `conductor` absent is legacy mode: nothing has decided the role yet, so a
 * conductor is still recognized by its mux name. `null` is no conductor. */
export const successionSchema = z.object({
  id: z.string().uuid(), generation: z.string().uuid(), side: z.enum(["origin", "successor"]),
  phase: z.enum(["preparing", "prepared", "committed", "aborted"]),
  originId: z.string().uuid(), destinationId: z.string().uuid(), previous: recordSchema, from: targetSchema,
  connection: z.object({ name: serverName, server: serverName, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), id: z.string().uuid() }).strict(),
  revoked: z.boolean().optional(), activated: z.boolean().optional(), target: targetSchema.optional(), resume: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type ConductorSuccession = z.infer<typeof successionSchema>;
const stateSchema = z.object({ version: z.literal(1), conductor: recordSchema.nullable().optional(), set: setNameSchema.optional(), succession: successionSchema.optional() });
export type RoleState = z.infer<typeof stateSchema>;

const roleFile = (root = bridgeRoot()) => path.join(root, "conductor-role.json");
/** The Hook is the only writer, so the last state it read or wrote stands in for the file. */
const cached = new Map<string, RoleState | undefined>();

/** The saved state; undefined before the file exists. */
export async function readRoleState(root = bridgeRoot()): Promise<RoleState | undefined> {
  const file = roleFile(root);
  if (cached.has(file)) return cached.get(file);
  // Read once per process and synchronously: the overview's time budget
  // should not wait on disk for a file of a few hundred bytes.
  let text: string | undefined;
  try {
    const info = lstatSync(file);
    // Only a small regular file the Hook wrote is read; anything else counts as damaged.
    text = info.isFile() && info.size <= 65_536 ? readFileSync(file, "utf8") : "";
  } catch { text = undefined; }
  let state: RoleState | undefined;
  if (text !== undefined) {
    // A damaged file is a state with no conductor, never a return to names.
    try { state = stateSchema.parse(JSON.parse(text)); } catch { state = { version: 1, conductor: null }; }
  }
  cached.set(file, state);
  return state;
}

async function writeRoleState(state: RoleState, root = bridgeRoot()): Promise<void> {
  const file = roleFile(root);
  await atomicInPrivateDir(file, JSON.stringify(state, null, 2) + "\n");
  cached.set(file, state);
  conductorOriginChanged(state.conductor);
}

/** Every read-modify-write of the state runs one at a time: an overview poll
 * noting a moved pane must not interleave with a make or stop and bring back
 * the record it replaced. */
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(run: () => Promise<T>, root = bridgeRoot()): Promise<T> {
  const queue = queues.get(root) ?? Promise.resolve();
  const next = queue.then(run, run);
  queues.set(root, next.catch(() => undefined));
  return next;
}

/** Uses the same serialization as every local role writer. */
export function updateConductorAuthority(root: string, change: (state: RoleState) => Promise<RoleState>): Promise<RoleState> {
  return serialized(async () => {
    const state = await change(await readRoleState(root) ?? { version: 1 });
    await writeRoleState(state, root);
    return state;
  }, root);
}
export function assertRoleMutable(state: RoleState | undefined): void {
  if (state?.succession && state.succession.phase !== "aborted") throw new BridgeError(409, "The conductor is moving or delegated to another computer; reconcile its ownership before changing the role.");
}

/** For tests: forget the cached state. */
export function resetRoleState(): void { cached.clear(); }

const liveStatus = (pane: Json) => !["completed", "exited", "failed", "stopped"].includes(String(pane.agent_status));
/** A pane running an agent the Hook can talk to. */
export const runsAgent = (pane: Json | undefined): pane is Json => !!pane && provider.safeParse(pane.agent).success && liveStatus(pane);

function recordFor(server: string, pane: Json, by: ConductorRecord["by"], session?: string): ConductorRecord {
  return {
    server, pane: String(pane.pane_id), ...(typeof pane.terminal_id === "string" ? { terminal: pane.terminal_id } : {}),
    ...(id.safeParse(pane.workspace_id).success ? { workspace: String(pane.workspace_id) } : {}),
    ...(id.safeParse(pane.tab_id).success ? { tab: String(pane.tab_id) } : {}),
    ...(provider.safeParse(pane.agent).success ? { source: pane.agent as ConductorRecord["source"] } : {}),
    ...(session ? { session } : {}), since: new Date().toISOString(), by,
  };
}

/** The one pane in a snapshot whose agent reports this session; none when it is absent or ambiguous. */
function sessionPane(session: string, s: Json): Json | undefined {
  const found = objects(s.panes).filter(p => runsAgent(p) && objects([p.agent_session])[0]?.value === session);
  return found.length === 1 ? found[0] : undefined;
}

/** The recorded pane in a snapshot of its server, when it is still the same terminal. */
function recordedPane(record: ConductorRecord, s: Json): Json | undefined {
  const pane = objects(s.panes).find(p => p.pane_id === record.pane);
  if (!pane) return undefined;
  // A pane id the multiplexer gave to a new terminal is another pane.
  if (record.terminal && typeof pane.terminal_id === "string" && pane.terminal_id !== record.terminal) return undefined;
  return pane;
}

/**
 * The conductor's pane on `server`, from a snapshot of it, whether or not an
 * agent runs there right now. A recorded pane gone from the snapshot ends the
 * role. In legacy mode a live pane with a conductor name is adopted and saved.
 */
export function conductorPane(server: string, s: Json, root = bridgeRoot()): Promise<Json | undefined> {
  const write = (state: RoleState) => writeRoleState(state, root);
  return serialized(async () => {
    const state = await readRoleState(root);
    if (state?.succession?.side === "origin" && state.succession.phase === "committed") return undefined;
    if (state?.succession?.side === "successor" && ["preparing", "prepared"].includes(state.succession.phase)) return undefined;
    if (state?.conductor === undefined) {
      const named = objects(s.panes).find(pane => isConductorName(paneAgentName(s, pane)) && runsAgent(pane));
      if (!named) return undefined;
      await write({ ...state, version: 1, conductor: recordFor(server, named, "migrated") });
      return named;
    }
    const record = state.conductor;
    if (!record || record.server !== server) return undefined;
    let pane = recordedPane(record, s);
    if (!pane) {
      // The pane went away or was recreated (a moved tab, a Herdr restart): the
      // role follows the session, so a pane running it takes the role over.
      const adopted = record.session ? sessionPane(record.session, s) : undefined;
      if (!adopted && state.succession && state.succession.phase !== "aborted") return undefined;
      if (!adopted) { await write({ ...state, conductor: null }); return undefined; }
      await write({ ...state, conductor: { ...recordFor(server, adopted, record.by, record.session), since: record.since } });
      return adopted;
    }
    // Keep the place current: a pane moved to another tab or workspace is the same pane.
    const moved = (id.safeParse(pane.workspace_id).success && pane.workspace_id !== record.workspace) || (id.safeParse(pane.tab_id).success && pane.tab_id !== record.tab)
      || (provider.safeParse(pane.agent).success && pane.agent !== record.source);
    if (moved) await write({ ...state, conductor: { ...record, workspace: String(pane.workspace_id), tab: String(pane.tab_id),
      ...(provider.safeParse(pane.agent).success ? { source: pane.agent as ConductorRecord["source"] } : {}) } });
    return pane;
  }, root);
}

/** The recorded conductor, whatever its server; undefined in legacy mode or with none. */
export async function recordedConductor(): Promise<ConductorRecord | undefined> {
  return (await readRoleState())?.conductor ?? undefined;
}

/** Makes `pane` on `server` this computer's conductor, replacing any record. */
export function recordConductor(server: string, pane: Json, by: ConductorRecord["by"], session?: string): Promise<ConductorRecord> {
  return serialized(async () => {
    const state = await readRoleState() ?? { version: 1 as const };
    assertRoleMutable(state);
    const record = recordFor(server, pane, by, session);
    await writeRoleState({ ...state, conductor: record });
    return record;
  });
}

/** Move only the captured role. The optional hand-over holds the receipt
 * writer's queue while preparing routing and committing this role; it must
 * roll routing back if commit fails. No role writer can interleave here. */
// This CAS covers local targets. ConductorSuccessionService owns remote
// generations while keeping the receipts and grants on their original Hook.
export function transferConductor(expected: ConductorRecord, server: string, pane: Json, session?: string,
  handOver: (commit: () => Promise<void>) => Promise<void> = commit => commit()): Promise<ConductorRecord> {
  return serialized(async () => {
    const state = await readRoleState();
    const current = state?.conductor;
    assertRoleMutable(state);
    // Include the generation (since), terminal and session, so a stop/make
    // or another move cannot be overwritten even if it used the same pane.
    if (!current || !recordSchema.keyof().options.every(field => current[field] === expected[field])) {
      throw new BridgeError(409, "The conductor changed during the move; nothing was transferred.");
    }
    const record = recordFor(server, pane, "owner", session);
    await handOver(() => writeRoleState({ ...state, version: 1, conductor: record }));
    return record;
  });
}

/** The session now running in the conductor's pane: a restart or new login reattaches here. */
export function noteConductorSession(server: string, pane: string, session: string): Promise<void> {
  return serialized(async () => {
    const state = await readRoleState();
    const record = state?.conductor;
    if (!state || !record || record.server !== server || record.pane !== pane || record.session === session) return;
    await writeRoleState({ ...state, conductor: { ...record, session } });
  });
}

/** Ends the role. With `pane`, only when that pane holds it. Returns what was stopped. */
export function clearConductor(pane?: string): Promise<ConductorRecord | undefined> {
  return serialized(async () => {
    const state = await readRoleState();
    const record = state?.conductor ?? undefined;
    assertRoleMutable(state);
    if (record && pane !== undefined && record.pane !== pane) return undefined;
    // Written even with nothing to clear: a stop also ends legacy mode, so a
    // leftover conductor name is not adopted again.
    await writeRoleState({ ...state, version: 1, conductor: null });
    return record;
  });
}

/** The set name this Hook holds. */
export async function readSetName(): Promise<SetName | undefined> {
  return (await readRoleState())?.set;
}

/** Keeps `name` when it is newer than the one held; `null` clears. Returns whether it changed. */
export function saveSetName(name: string | null, namedAt: string): Promise<boolean> {
  return serialized(async () => {
    const state = await readRoleState();
    const held = state?.set;
    if (held && Date.parse(held.namedAt) >= Date.parse(namedAt)) return false;
    await writeRoleState({ ...state, version: 1, set: { name, namedAt } });
    return held?.name !== name;
  });
}
