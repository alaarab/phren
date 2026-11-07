/**
 * The `dreaming` config domain: the offline pass that reorganizes a project's
 * memory between sessions (docs/dreaming.md). Off by default.
 *
 * Global values live in `.config/dreaming.json`; a project overrides any of
 * them under `config.dreaming` in its `phren.project.yaml`. Reads are lenient
 * (an invalid value falls back to the level below it); writes validate and say
 * why a value was refused.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { appendAuditLog, isRecord } from "../shared.js";
import { withFileLock } from "../governance/locks.js";
import { readProjectConfig, updateProjectConfigOverrides } from "../project-config.js";

export const DREAM_MODES = ["propose", "apply"] as const;
export type DreamMode = typeof DREAM_MODES[number];

export const DREAM_CADENCES = ["nightly", "idle", "weekly", "manual"] as const;
export type DreamCadence = typeof DREAM_CADENCES[number];

export const DREAM_PHASES = ["capture", "correct", "organize", "prune"] as const;
export type DreamPhase = typeof DREAM_PHASES[number];

export interface DreamingConfig {
  enabled: boolean;
  mode: DreamMode;
  cadence: DreamCadence;
  /** `HH:MM-HH:MM` local time; may wrap midnight (`22:00-02:00`). */
  window: string;
  idleMinutes: number;
  lookbackHours: number;
  maxChanges: number;
  injectBudgetKB: number;
  phases: DreamPhase[];
  /** Empty means the project's helper model. */
  model: string;
}

export const DEFAULT_DREAMING_CONFIG: Readonly<DreamingConfig> = Object.freeze({
  enabled: false,
  mode: "propose",
  cadence: "nightly",
  window: "02:00-05:00",
  idleMinutes: 45,
  lookbackHours: 24,
  maxChanges: 25,
  injectBudgetKB: 8,
  phases: [...DREAM_PHASES],
  model: "",
});

/** Inclusive ranges for the numeric keys; the schema descriptors share them. */
export const DREAMING_RANGES = {
  idleMinutes: { min: 5, max: 1440, step: 5 },
  lookbackHours: { min: 1, max: 720, step: 1 },
  maxChanges: { min: 1, max: 200, step: 1 },
  injectBudgetKB: { min: 1, max: 256, step: 1 },
} as const;

export const DREAMING_KEYS = Object.keys(DEFAULT_DREAMING_CONFIG) as Array<keyof DreamingConfig>;

const WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/;

/** Minutes after local midnight for each end of a `HH:MM-HH:MM` window, or null when malformed. */
export function parseDreamWindow(window: string): { start: number; end: number } | null {
  const match = WINDOW_RE.exec(window.trim());
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  return start === end ? null : { start, end };
}

/** True when `date`'s local time of day falls inside the window (start inclusive, end exclusive). */
export function insideDreamWindow(window: string, date: Date): boolean {
  const parsed = parseDreamWindow(window) ?? parseDreamWindow(DEFAULT_DREAMING_CONFIG.window)!;
  const minute = date.getHours() * 60 + date.getMinutes();
  return parsed.start < parsed.end
    ? minute >= parsed.start && minute < parsed.end
    : minute >= parsed.start || minute < parsed.end;
}

type Check = (value: unknown) => { ok: true; value: unknown } | { ok: false; reason: string };

function intIn(key: keyof typeof DREAMING_RANGES): Check {
  const { min, max } = DREAMING_RANGES[key];
  return (value) => {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max
      ? { ok: true, value: n }
      : { ok: false, reason: `${key} must be a whole number from ${min} to ${max}.` };
  };
}

function oneOf(key: string, values: readonly string[]): Check {
  return (value) => typeof value === "string" && values.includes(value.trim().toLowerCase())
    ? { ok: true, value: value.trim().toLowerCase() }
    : { ok: false, reason: `${key} must be one of: ${values.join(", ")}.` };
}

const CHECKS: Record<keyof DreamingConfig, Check> = {
  enabled: (value) => {
    if (typeof value === "boolean") return { ok: true, value };
    if (value === "true" || value === "on") return { ok: true, value: true };
    if (value === "false" || value === "off") return { ok: true, value: false };
    return { ok: false, reason: "enabled must be true or false." };
  },
  mode: oneOf("mode", DREAM_MODES),
  cadence: oneOf("cadence", DREAM_CADENCES),
  window: (value) => typeof value === "string" && parseDreamWindow(value)
    ? { ok: true, value: value.trim() }
    : { ok: false, reason: "window must be HH:MM-HH:MM in local time, with different start and end (e.g. 02:00-05:00)." },
  idleMinutes: intIn("idleMinutes"),
  lookbackHours: intIn("lookbackHours"),
  maxChanges: intIn("maxChanges"),
  injectBudgetKB: intIn("injectBudgetKB"),
  // Unknown phases are ignored, so a newer store's phase list still loads here.
  phases: (value) => {
    const list = typeof value === "string" ? value.split(",") : value;
    if (!Array.isArray(list)) return { ok: false, reason: `phases must be a list of: ${DREAM_PHASES.join(", ")}.` };
    const known = [...new Set(list.map((p) => String(p).trim().toLowerCase()))]
      .filter((p): p is DreamPhase => (DREAM_PHASES as readonly string[]).includes(p));
    return known.length ? { ok: true, value: known } : { ok: false, reason: `phases must include at least one of: ${DREAM_PHASES.join(", ")}.` };
  },
  model: (value) => typeof value === "string" && (value.trim() === "" || MODEL_RE.test(value.trim()))
    ? { ok: true, value: value.trim() }
    : { ok: false, reason: "model must be empty (the project's helper model) or a model name such as sonnet or claude-sonnet-5-5." },
};

export interface DreamingPatchResult {
  patch: Partial<DreamingConfig>;
  /** One sentence per refused key. */
  errors: string[];
  /** Keys that are not dreaming settings. */
  unknown: string[];
}

/** Validate a user-supplied partial config. Values may be strings (CLI) or typed (MCP, JSON). */
export function parseDreamingPatch(raw: unknown): DreamingPatchResult {
  const result: DreamingPatchResult = { patch: {}, errors: [], unknown: [] };
  if (!isRecord(raw)) {
    result.errors.push("Dreaming settings must be an object.");
    return result;
  }
  for (const [key, value] of Object.entries(raw)) {
    const check = CHECKS[key as keyof DreamingConfig];
    if (!check) { result.unknown.push(key); continue; }
    if (value === undefined) continue;
    const checked = check(value);
    if (checked.ok) (result.patch as Record<string, unknown>)[key] = checked.value;
    else result.errors.push(checked.reason);
  }
  return result;
}

/** The valid keys of a stored object; anything malformed is dropped so the level below shows through. */
export function normalizeDreamingLevel(raw: unknown): Partial<DreamingConfig> {
  return parseDreamingPatch(isRecord(raw) ? raw : {}).patch;
}

export function globalDreamingPath(phrenPath: string): string {
  return path.join(phrenPath, ".config", "dreaming.json");
}

export function readGlobalDreaming(phrenPath: string): Partial<DreamingConfig> {
  try {
    return normalizeDreamingLevel(JSON.parse(fs.readFileSync(globalDreamingPath(phrenPath), "utf8")));
  } catch {
    return {};
  }
}

export function readProjectDreaming(phrenPath: string, project: string): Partial<DreamingConfig> {
  try {
    return normalizeDreamingLevel(readProjectConfig(phrenPath, project).config?.dreaming);
  } catch {
    return {};
  }
}

/** The effective dreaming config: defaults, then the global file, then the project's override. */
export function getDreamingConfig(phrenPath: string, project?: string): DreamingConfig {
  return {
    ...DEFAULT_DREAMING_CONFIG,
    phases: [...DEFAULT_DREAMING_CONFIG.phases],
    ...readGlobalDreaming(phrenPath),
    ...(project ? readProjectDreaming(phrenPath, project) : {}),
  };
}

/**
 * Write a validated patch globally or for one project. `null` for a key on a
 * project removes that project's override so it inherits again.
 */
export function updateDreamingConfig(
  phrenPath: string,
  patch: Partial<DreamingConfig>,
  project?: string,
  clear: Array<keyof DreamingConfig> = [],
): Partial<DreamingConfig> {
  if (project) {
    let written: Partial<DreamingConfig> = {};
    updateProjectConfigOverrides(phrenPath, project, (current) => {
      const existing = normalizeDreamingLevel(current.dreaming);
      for (const key of clear) delete existing[key];
      written = { ...existing, ...patch };
      const next = { ...current };
      if (Object.keys(written).length) next.dreaming = written; else delete next.dreaming;
      return next;
    });
    appendAuditLog(phrenPath, "update_dreaming_config", JSON.stringify({ project, ...written }));
    return written;
  }
  const file = globalDreamingPath(phrenPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = withFileLock(file, () => {
    const current = readGlobalDreaming(phrenPath);
    for (const key of clear) delete current[key];
    const merged = { ...current, ...patch };
    const tmp = `${file}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
    fs.renameSync(tmp, file);
    return merged;
  });
  appendAuditLog(phrenPath, "update_dreaming_config", JSON.stringify(next));
  return next;
}
