import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { Inventory, InventoryAction, InventorySession, InventorySpace, InventoryWorktree } from "./inventory.js";

/**
 * `GET /v1/housekeeping/inventory?section=worktrees|space|sessions`: one
 * section of the last inventory scan, shaped as the phone asked. Each row has
 * either an `action` (approvable now) or a `kept` reason (why Phren won't),
 * never both. Row ids are prefixed (`wt:`, `sp:`, `ss:`) and go to
 * `POST /v1/housekeeping/approve` beside report suggestion ids; they hash the
 * row's state, so a changed row has a new id and a stale one is `gone`.
 * The schemas here are the contract (fixtures/conformance/housekeeping-inventory.json).
 */

export const SECTIONS = ["worktrees", "space", "sessions"] as const;
export type Section = typeof SECTIONS[number];
export const MAX_ROWS = 500;
const PREFIX: Record<Section, string> = { worktrees: "wt:", space: "sp:", sessions: "ss:" };

const iso = z.string().datetime({ offset: true });
const rowAction = z.object({ label: z.string(), confirm: z.string().optional() });
const common = { id: z.string(), title: z.string(), sizeBytes: z.number().optional(), action: rowAction.optional(), kept: z.string().optional() };
const target = z.object({ server: z.string(), workspace: z.string().optional(), tab: z.string().optional(), pane: z.string() }).passthrough();

export const worktreeRowSchema = z.object({
  ...common, repo: z.string(), path: z.string(), branch: z.string().optional(), lastCommitAt: iso.optional(),
  dirty: z.number(), untracked: z.number(), unpushed: z.number(), stash: z.boolean(), operation: z.string().optional(), main: z.boolean(),
  sessions: z.array(z.object({ target, label: z.string(), harness: z.string().optional() })),
  processes: z.array(z.object({ pid: z.number(), name: z.string() })),
});
export const spaceRowSchema = z.object({
  ...common, sizeBytes: z.number(),
  kind: z.enum(["cache", "derivedData", "simulator", "docker", "tmp", "nodeModules", "archive", "logs", "other"]),
  path: z.string().optional(), lastUsedAt: iso.optional(), inUse: z.string().optional(),
});
export const sessionRowSchema = z.object({
  ...common, kind: z.enum(["pane", "tmux"]), project: z.string().optional(), harness: z.string().optional(), target, idleSeconds: z.number(),
  state: z.enum(["working", "waiting", "idle", "finished", "exited", "no-client"]), dispatch: z.object({ id: z.string(), returnRead: z.boolean() }).optional(),
});
const exclusive = (row: { action?: unknown; kept?: unknown }) => Boolean(row.action) !== Boolean(row.kept);
const sectionOf = <S extends Section, R extends z.ZodType<{ action?: unknown; kept?: unknown }>>(section: S, row: R) => z.object({
  schema: z.literal(1), section: z.literal(section), revision: z.string(), measuredAt: iso, partial: z.boolean().optional(),
  rows: z.array(row.refine(exclusive, "a row has an action or a kept reason, never both")).max(MAX_ROWS),
});
export const sectionSchema = z.discriminatedUnion("section", [
  sectionOf("worktrees", worktreeRowSchema), sectionOf("space", spaceRowSchema), sectionOf("sessions", sessionRowSchema),
]);
export type SectionView = z.infer<typeof sectionSchema>;

const GB = 1024 ** 3;
const size = (bytes?: number) => bytes === undefined ? "" : bytes >= GB ? ` (${(bytes / GB).toFixed(1)} GB)` : ` (${Math.max(1, Math.round(bytes / 1024 ** 2))} MB)`;

/** An action, or why not. */
function handle(action: InventoryAction | undefined, confirm: string, never?: string): { action?: z.infer<typeof rowAction>; kept?: string } {
  if (action?.allowed) return { action: { label: action.label, confirm } };
  return { kept: action?.reason ?? never ?? "Phren doesn't handle this." };
}

const OPERATIONS: Record<string, string> = { "rebase-merge": "rebase", "rebase-apply": "rebase", MERGE_HEAD: "merge", CHERRY_PICK_HEAD: "cherry-pick", REVERT_HEAD: "revert", BISECT_LOG: "bisect" };

function worktreeRow(row: InventoryWorktree): z.infer<typeof worktreeRowSchema> {
  return {
    id: PREFIX.worktrees + row.action.id, title: path.basename(row.path), ...(row.sizeBytes !== undefined ? { sizeBytes: row.sizeBytes } : {}),
    repo: row.repo, path: row.path, ...(row.branch ? { branch: row.branch } : {}), ...(row.lastCommitAt ? { lastCommitAt: row.lastCommitAt } : {}),
    dirty: row.dirty, untracked: row.untracked, unpushed: row.unpushed, stash: row.stashes > 0,
    ...(row.inProgress ? { operation: OPERATIONS[row.inProgress] ?? row.inProgress } : {}), main: row.main,
    sessions: row.sessions.map(s => ({ target: s.pane.target, label: s.pane.label ?? s.title ?? s.pane.target.pane, ...(s.agent ? { harness: s.agent } : {}) })),
    processes: row.processes.map(p => ({ pid: p.pid, name: p.command ?? "process" })),
    ...handle(row.action, `Remove the worktree at ${row.path}?${row.branch ? ` Branch ${row.branch} stays.` : ""}`),
  };
}

const SPACE_KIND: Record<InventorySpace["kind"], z.infer<typeof spaceRowSchema>["kind"]> = {
  cache: "cache", "derived-data": "derivedData", "xctest-devices": "simulator", "device-support": "cache", simulator: "simulator",
  docker: "docker", tmp: "tmp", node_modules: "nodeModules",
};

function spaceRow(row: InventorySpace): z.infer<typeof spaceRowSchema> {
  const what = row.path ?? row.title;
  const confirm = row.action?.kind === "shutdown-simulator" ? `Shut down ${row.title}?`
    : row.action?.kind === "delete-simulator" ? `Delete the simulator ${row.title} and its data${size(row.sizeBytes)}?`
    : row.action?.kind === "prune-docker-builder" ? `Prune docker build cache older than a week${size(row.sizeBytes)}?`
    : `Delete ${what}${size(row.sizeBytes)}? This can't be undone.`;
  return {
    id: PREFIX.space + (row.action?.id ?? row.id), title: row.title, sizeBytes: row.sizeBytes, kind: SPACE_KIND[row.kind],
    ...(row.path ? { path: row.path } : {}), ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}), ...(row.inUse ? { inUse: row.inUse } : {}),
    ...handle(row.action, confirm, row.never),
  };
}

function sessionState(status: string | undefined): z.infer<typeof sessionRowSchema>["state"] {
  if (status === "working") return "working";
  if (status === "blocked" || status === "waiting") return "waiting";
  if (status === "done") return "finished";
  return "idle";
}

function sessionRow(row: InventorySession): z.infer<typeof sessionRowSchema> {
  const label = row.pane.label ?? row.title ?? row.pane.target.pane;
  return {
    id: PREFIX.sessions + row.action.id, title: label, kind: row.pane.target.server.startsWith("tmux") ? "tmux" : "pane",
    ...(row.project ? { project: row.project } : {}), ...(row.agent ? { harness: row.agent } : {}), target: row.pane.target,
    idleSeconds: row.idleSeconds ?? 0, state: sessionState(row.status), ...(row.receipt ? { dispatch: row.receipt } : {}),
    ...handle(row.action, `Close the pane ${label}? Its agent stops.`),
  };
}

export function sectionView(inventory: Inventory, section: Section, partial: boolean): SectionView {
  const rows = section === "worktrees" ? inventory.worktrees.map(worktreeRow)
    : section === "space" ? inventory.space.map(spaceRow)
    : inventory.sessions.map(sessionRow);
  const capped = rows.slice(0, MAX_ROWS);
  return {
    schema: 1, section, revision: createHash("sha256").update(JSON.stringify(capped)).digest("hex").slice(0, 16), measuredAt: inventory.collectedAt,
    ...(partial ? { partial: true } : {}), rows: capped,
  } as SectionView;
}

/** The inventory row a prefixed approve id names, if any. */
export function findRow(inventory: Inventory, id: string): { section: Section; row: InventoryWorktree | InventorySpace | InventorySession } | undefined {
  if (id.startsWith(PREFIX.worktrees)) { const row = inventory.worktrees.find(r => r.action.id === id.slice(3)); return row ? { section: "worktrees", row } : undefined; }
  if (id.startsWith(PREFIX.space)) { const row = inventory.space.find(r => r.action?.id === id.slice(3)); return row ? { section: "space", row } : undefined; }
  if (id.startsWith(PREFIX.sessions)) { const row = inventory.sessions.find(r => r.action.id === id.slice(3)); return row ? { section: "sessions", row } : undefined; }
  return undefined;
}
