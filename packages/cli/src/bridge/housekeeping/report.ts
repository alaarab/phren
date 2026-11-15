import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ComputerResources } from "../resources.js";
import type { Blocker } from "./safety.js";

/**
 * The housekeeping report. A pass produces a stored report (every item it
 * found, with its section); `GET /v1/housekeeping` serves a view of it shaped
 * for the phone (warnings, suggestions, kept, cleaned), minus dismissed items.
 * The view's schema below is the contract: docs/housekeeping.md documents it,
 * fixtures/conformance/housekeeping-*.json exercise it, and the apps decode
 * those fixtures. Add fields freely; change or remove one only with `schema` + 1.
 */

export const SCHEMA = 1;

export const AREAS = ["memory", "disk", "sessions", "worktrees", "simulators", "docker"] as const;
export type Area = typeof AREAS[number];
export type ItemKind = "cache" | "worktree" | "tmp" | "pane" | "job" | "simulator" | "docker" | "health";
export type Severity = "info" | "warn" | "high";
export type Trigger = "tick" | "low-disk" | "high-load" | "manual" | "approve";
export type ActionKind = "delete-path" | "remove-worktree" | "close-pane" | "end-job" | "shutdown-simulator" | "prune-docker-builder";
/** warning: an observation; suggestion: needs the owner; kept: a safety rule holds it; auto: the Hook does it itself. */
export type Section = "warning" | "suggestion" | "kept" | "auto";

const iso = z.string().datetime({ offset: true });
const paneSchema = z.object({
  target: z.object({ server: z.string(), workspace: z.string().optional(), tab: z.string().optional(), pane: z.string() }).passthrough(),
  label: z.string().optional(),
});
const targetSchema = z.object({
  path: z.string().optional(), repo: z.string().optional(), branch: z.string().optional(),
  pid: z.number().int().optional(), udid: z.string().optional(), name: z.string().optional(),
});
const area = z.enum(AREAS);
const severity = z.enum(["high", "warn", "info"]);

export const warningSchema = z.object({
  id: z.string(), area, severity, title: z.string(), detail: z.string(), since: iso,
  fix: z.string().optional(), pane: paneSchema.optional(), session: z.string().optional(), dispatch: z.string().optional(), notify: z.boolean().optional(),
});
export const suggestionSchema = z.object({
  id: z.string(), area, kind: z.string(), title: z.string(), target: targetSchema, reason: z.string(), evidence: z.array(z.string()),
  sizeBytes: z.number().optional(), actionLabel: z.string(), since: iso,
  pane: paneSchema.optional(), session: z.string().optional(), dispatch: z.string().optional(),
});
export const keptSchema = z.object({ id: z.string(), area, title: z.string(), target: targetSchema, reason: z.string() });
export const cleanedSchema = z.object({
  id: z.string(), at: iso, area, kind: z.string(), title: z.string(), target: targetSchema,
  freedBytes: z.number(), reportedBytes: z.number().optional(), by: z.enum(["auto", "phone", "conductor", "cli"]),
});
export const dismissedSchema = z.object({ id: z.string(), section: z.enum(["warnings", "suggestions", "kept"]), area, title: z.string(), dismissedAt: iso });
export const viewSchema = z.object({
  schema: z.literal(SCHEMA),
  revision: z.string(),
  generatedAt: iso,
  nextCheckAt: iso.optional(),
  health: z.object({
    load1: z.number(), cores: z.number(), memoryUsedBytes: z.number(), memoryTotalBytes: z.number(),
    memoryPressure: z.enum(["normal", "warn", "critical"]), diskFreeBytes: z.number(), diskTotalBytes: z.number(), tmpBytes: z.number().optional(),
  }),
  warnings: z.array(warningSchema),
  suggestions: z.array(suggestionSchema),
  kept: z.array(keptSchema),
  cleaned: z.array(cleanedSchema),
  dismissed: z.array(dismissedSchema).optional(),
  errors: z.array(z.object({ check: z.string(), message: z.string() })).optional(),
});
export const approveResultSchema = z.object({
  results: z.array(z.object({ id: z.string(), status: z.enum(["done", "refused", "failed", "gone", "started"]), reason: z.string().optional(), freedBytes: z.number().optional() })),
  revision: z.string(),
});
export const badgeSchema = z.object({ revision: z.string(), warnings: z.number(), suggestions: z.number(), worst: severity.nullable(), freedTodayBytes: z.number() });

export type HousekeepingView = z.infer<typeof viewSchema>;
export type Warning = z.infer<typeof warningSchema>;
export type Suggestion = z.infer<typeof suggestionSchema>;
export type Kept = z.infer<typeof keptSchema>;
export type Cleaned = z.infer<typeof cleanedSchema>;
export type ApproveResult = z.infer<typeof approveResultSchema>;
export type Badge = z.infer<typeof badgeSchema>;
export type ItemTarget = z.infer<typeof targetSchema>;
export type PaneLink = z.infer<typeof paneSchema>;

/** What a check proposes. */
export interface ItemDraft {
  section: Section;
  area: Area;
  kind: ItemKind;
  title: string;
  /** Plain sentence: why (a suggestion's or kept item's reason, a warning's detail). */
  reason: string;
  target: ItemTarget;
  /** The state that, when it changes, makes this a new item (new id, dismissal lapses). */
  fingerprint: string;
  /** A fixed id (machine-health findings keep theirs); otherwise derived from kind, target and fingerprint. */
  id?: string;
  severity?: Severity;
  fix?: string;
  evidence?: string[];
  sizeBytes?: number;
  action?: ActionKind;
  actionLabel?: string;
  blockers?: Blocker[];
  notify?: boolean;
  pane?: PaneLink;
  session?: string;
  dispatch?: string;
}

export interface StoredItem extends ItemDraft { id: string; since: string }

export interface StoredReport {
  version: 1;
  id: string;
  computer: string;
  generatedAt: string;
  trigger: Trigger;
  durationMs: number;
  health: HousekeepingView["health"];
  items: StoredItem[];
  errors?: Array<{ check: string; message: string }>;
}

export function itemId(kind: ItemKind, target: ItemTarget, fingerprint: string): string {
  const identity = [kind, target.path ?? "", target.repo ?? "", target.branch ?? "", target.pid ?? "", target.udid ?? "", target.name ?? "", fingerprint];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
}

/** Only a cache may be cleaned without the owner; anything else proposing `auto` becomes a suggestion. */
export function clampSection(kind: ItemKind, section: Section): Section {
  return section === "auto" && kind !== "cache" ? "suggestion" : section;
}

export function healthOf(resources: ComputerResources): HousekeepingView["health"] {
  const total = resources.memory.totalBytes;
  const available = resources.memory.availablePercent;
  return {
    load1: resources.cpu.load1, cores: resources.cpu.cores,
    memoryUsedBytes: available === undefined ? 0 : Math.round(total * (1 - available / 100)), memoryTotalBytes: total,
    memoryPressure: resources.memory.pressure ?? "normal",
    diskFreeBytes: resources.disk?.freeBytes ?? 0, diskTotalBytes: resources.disk?.totalBytes ?? 0,
  };
}

const RANK: Record<Severity, number> = { high: 0, warn: 1, info: 2 };

export function buildReport(input: {
  computer: string; trigger: Trigger; startedAt: number; finishedAt: number; drafts: ItemDraft[];
  previous?: StoredReport; health: HousekeepingView["health"]; errors?: StoredReport["errors"];
}): StoredReport {
  const before = new Map((input.previous?.items ?? []).map(item => [item.id, item]));
  const generatedAt = new Date(input.finishedAt).toISOString();
  const items: StoredItem[] = [];
  const seen = new Set<string>();
  for (const draft of input.drafts) {
    const id = draft.id ?? itemId(draft.kind, draft.target, draft.fingerprint);
    if (seen.has(id)) continue;
    seen.add(id);
    const section = clampSection(draft.kind, draft.section);
    const prior = before.get(id);
    // A fixed id (a health finding) is the same item only while its fingerprint holds.
    const since = prior && prior.fingerprint === draft.fingerprint ? prior.since : generatedAt;
    items.push({ ...draft, id, section, since });
  }
  items.sort((a, b) => RANK[a.severity ?? "info"] - RANK[b.severity ?? "info"] || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || a.title.localeCompare(b.title));
  return {
    version: 1, id: randomBytes(6).toString("hex"), computer: input.computer, generatedAt, trigger: input.trigger,
    durationMs: Math.max(0, input.finishedAt - input.startedAt), health: input.health, items,
    ...(input.errors?.length ? { errors: input.errors } : {}),
  };
}

const SECTION_NAME = { warning: "warnings", suggestion: "suggestions", kept: "kept" } as const;

/** The phone's view: dismissed items left out (listed when asked), cleaned from the log, a revision over all of it. */
export function viewOf(report: StoredReport, options: { cleaned: Cleaned[]; dismissed: Map<string, { fingerprint: string; at: string }>; includeDismissed?: boolean; nextCheckAt?: string }): HousekeepingView {
  const warnings: Warning[] = [], suggestions: Suggestion[] = [], kept: Kept[] = [], dismissed: z.infer<typeof dismissedSchema>[] = [];
  for (const item of report.items) {
    if (item.section === "auto") continue; // shown in `cleaned` once done, or as a warning if it failed
    const mark = options.dismissed.get(item.id);
    if (mark && mark.fingerprint === item.fingerprint) {
      dismissed.push({ id: item.id, section: SECTION_NAME[item.section], area: item.area, title: item.title, dismissedAt: mark.at });
      continue;
    }
    const links = { ...(item.pane ? { pane: item.pane } : {}), ...(item.session ? { session: item.session } : {}), ...(item.dispatch ? { dispatch: item.dispatch } : {}) };
    if (item.section === "warning") warnings.push({ id: item.id, area: item.area, severity: item.severity ?? "info", title: item.title, detail: item.reason,
      since: item.since, ...(item.fix ? { fix: item.fix } : {}), ...links, ...(item.notify ? { notify: true } : {}) });
    else if (item.section === "suggestion") suggestions.push({ id: item.id, area: item.area, kind: item.kind, title: item.title, target: item.target, reason: item.reason,
      evidence: item.evidence ?? [], ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}), actionLabel: item.actionLabel ?? "Apply", since: item.since, ...links });
    else kept.push({ id: item.id, area: item.area, title: item.title, target: item.target, reason: item.reason });
  }
  const body = { warnings, suggestions, kept, cleaned: options.cleaned };
  const revision = createHash("sha256").update(JSON.stringify([body, dismissed.map(d => d.id)])).digest("hex").slice(0, 16);
  return {
    schema: SCHEMA, revision, generatedAt: report.generatedAt, ...(options.nextCheckAt ? { nextCheckAt: options.nextCheckAt } : {}),
    health: report.health, ...body, ...(options.includeDismissed ? { dismissed } : {}), ...(report.errors?.length ? { errors: report.errors } : {}),
  };
}

export function badgeOf(view: HousekeepingView, now: number): Badge {
  const worst = view.warnings.reduce<Severity | null>((w, item) => w === null || RANK[item.severity] < RANK[w] ? item.severity : w, null);
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  return {
    revision: view.revision, warnings: view.warnings.length, suggestions: view.suggestions.length, worst,
    freedTodayBytes: view.cleaned.filter(entry => Date.parse(entry.at) >= day.getTime()).reduce((sum, entry) => sum + entry.freedBytes, 0),
  };
}
