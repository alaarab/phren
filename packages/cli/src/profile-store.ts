import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as yaml from "js-yaml";
import {
  phrenErr,
  PhrenError,
  phrenOk,
  type PhrenResult,
  forwardErr,
  getProjectDirs,
  readRootManifest,
} from "./shared.js";
import { defaultMachineName, getMachineName } from "./machine-identity.js";
import { errorMessage, isValidProjectName } from "./utils.js";
import { TASK_FILE_ALIASES } from "./data/tasks.js";
import { FINDINGS_FILENAME } from "./data/access.js";
import { withSafeLock } from "./shared/data-utils.js";
import { logger } from "./logger.js";
import type { RetentionPolicyPatch } from "./governance/policy.js";
import {
  VALID_FINDING_SENSITIVITY,
  VALID_PROACTIVITY_LEVELS,
  VALID_TASK_MODES,
  VALID_RISKY_SECTIONS,
} from "./governance/policy.js";
import { getNonPrimaryStores, getStoreProjectDirs } from "./store-registry.js";

export interface ProfilePolicyDefaults {
  findingSensitivity?: "minimal" | "conservative" | "balanced" | "aggressive";
  proactivity?: "high" | "medium" | "low";
  proactivityFindings?: "high" | "medium" | "low";
  proactivityTask?: "high" | "medium" | "low";
  taskMode?: "off" | "manual" | "suggest" | "auto";
  retentionPolicy?: RetentionPolicyPatch;
  workflowPolicy?: {
    lowConfidenceThreshold?: number;
    riskySections?: Array<"Review" | "Stale" | "Conflicts">;
  };
}

export interface ProfileInfo {
  name: string;
  description?: string;
  file: string;
  projects: string[];
  defaults?: ProfilePolicyDefaults;
}

export interface ProjectCard {
  name: string;
  summary: string;
  docs: string[];
}

export function resolveActiveProfile(phrenPath: string, requestedProfile?: string): PhrenResult<string | undefined> {
  const manifest = readRootManifest(phrenPath);
  if (manifest?.installMode === "project-local") {
    return phrenOk(undefined);
  }

  if (requestedProfile) {
    const profiles = listProfiles(phrenPath);
    if (!profiles.ok) return forwardErr(profiles);
    const exists = profiles.data.some((entry) => entry.name === requestedProfile);
    if (!exists) return phrenErr(`Profile "${requestedProfile}" not found.`, PhrenError.NOT_FOUND);
    return phrenOk(requestedProfile);
  }

  const machines = listMachines(phrenPath);
  if (machines.ok) {
    const profiles = listProfiles(phrenPath);
    if (!profiles.ok) return phrenOk(undefined);
    const candidates = [getMachineName(), defaultMachineName()].filter((value, index, values) => value && values.indexOf(value) === index);
    for (const machineName of candidates) {
      const mapped = machines.data[machineName];
      if (!mapped) continue;
      const exists = profiles.data.some((entry) => entry.name === mapped);
      if (exists) return phrenOk(mapped);
    }
  }

  const profiles = listProfiles(phrenPath);
  if (!profiles.ok) return phrenOk(undefined);

  // No mapping matched. With a single profile there is nothing to get wrong, so
  // adopt it quietly. With several, the mapping key is the OS hostname — which
  // changes on a re-image, a WSL/devcontainer switch, or a brand-new laptop that
  // cloned the store — and silently adopting the alphabetically-first profile
  // puts another profile's projects on a machine the user never mapped. Still
  // return it (returning undefined would index *every* profile's projects, which
  // is strictly worse), but say so exactly once so the user can fix the mapping.
  const assumed = profiles.data[0]?.name;
  if (assumed && profiles.data.length > 1) warnUnmappedMachine(getMachineName(), assumed);
  return phrenOk(assumed);
}

/** Machines already warned about this process — the notice is per-run, not per-call. */
const warnedUnmappedMachines = new Set<string>();

function warnUnmappedMachine(machine: string, assumed: string): void {
  if (warnedUnmappedMachines.has(machine)) return;
  warnedUnmappedMachines.add(machine);
  logger.debug("profile-store", `machine ${machine} unmapped; assuming profile ${assumed}`);
  if (process.env.PHREN_QUIET === "1") return;
  process.stderr.write(
    `[phren] machine "${machine}" is not mapped in machines.yaml — assuming profile "${assumed}". ` +
      `Run 'phren profile map ${machine} <profile>' to pin it.\n`,
  );
}

/** Test hook: forget which machines have been warned about. */
export function _resetUnmappedMachineWarnings(): void {
  warnedUnmappedMachines.clear();
}

/**
 * Is this machine's profile an assumption rather than a mapping? `phren status`
 * surfaces this so an unmapped machine is visible before it indexes the wrong
 * profile's projects.
 */
export function describeProfileMapping(phrenPath: string): { machine: string; mapped: boolean; assumed?: string } {
  const machine = getMachineName();
  const machines = listMachines(phrenPath);
  const profiles = listProfiles(phrenPath);
  if (machines.ok && profiles.ok) {
    for (const name of [machine, defaultMachineName()]) {
      const mapped = machines.data[name];
      if (mapped && profiles.data.some((entry) => entry.name === mapped)) {
        return { machine, mapped: true };
      }
    }
  }
  const assumed = profiles.ok ? profiles.data[0]?.name : undefined;
  return { machine, mapped: false, ...(assumed ? { assumed } : {}) };
}

export function getDefaultMachineAlias(): string {
  return getMachineName();
}

export function listMachines(phrenPath: string): PhrenResult<Record<string, string>> {
  const machinesPath = path.join(phrenPath, "machines.yaml");
  if (!fs.existsSync(machinesPath)) return phrenErr(`machines.yaml not found. Run 'phren init' to set up your phren.`, PhrenError.FILE_NOT_FOUND);
  try {
    const raw = fs.readFileSync(machinesPath, "utf8");
    const parsed = yaml.load(raw, { schema: yaml.CORE_SCHEMA });
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return phrenErr(`machines.yaml is empty or not valid YAML. Check the file format or run 'phren doctor --fix'.`, PhrenError.MALFORMED_YAML);

    const cleaned: Record<string, string> = {};
    for (const [machine, profile] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof machine !== "string" || !machine.trim()) continue;
      if (typeof profile !== "string" || !profile.trim()) continue;
      cleaned[machine] = profile;
    }
    return phrenOk(cleaned);
  } catch (err: unknown) {
    logger.debug("profile-store", `listMachines yaml parse: ${errorMessage(err)}`);
    return phrenErr(`Could not parse machines.yaml. Check the file for syntax errors or run 'phren doctor --fix'.`, PhrenError.MALFORMED_YAML);
  }
}

function writeMachines(phrenPath: string, data: Record<string, string>): void {
  const machinesPath = path.join(phrenPath, "machines.yaml");
  const backupPath = `${machinesPath}.bak`;
  const existing = fs.existsSync(machinesPath) ? fs.readFileSync(machinesPath, "utf8") : "";
  if (fs.existsSync(machinesPath)) fs.copyFileSync(machinesPath, backupPath);
  const ordered = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
  const headerLines: string[] = [];
  for (const line of existing.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") {
      headerLines.push(line);
      continue;
    }
    break;
  }
  const header = headerLines.length ? `${headerLines.join("\n")}\n` : "";
  const tmpPath = `${machinesPath}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, header + yaml.dump(ordered, { lineWidth: 1000 }));
  fs.renameSync(tmpPath, machinesPath);
}

export function setMachineProfile(phrenPath: string, machine: string, profile: string): PhrenResult<string> {
  if (!machine || !profile) return phrenErr(`Both machine name and profile name are required. Example: :machine map my-laptop personal`, PhrenError.EMPTY_INPUT);

  const profiles = listProfiles(phrenPath);
  if (profiles.ok) {
    const exists = profiles.data.some((entry) => entry.name === profile);
    if (!exists) return phrenErr(`Profile "${profile}" does not exist. Check available profiles in the profiles/ directory.`, PhrenError.NOT_FOUND);
  }

  const machinesPath = path.join(phrenPath, "machines.yaml");
  return withSafeLock(machinesPath, () => {
    const current = listMachines(phrenPath);
    // A file that exists and carries mappings phren cannot parse must never be
    // rewritten from an empty map: writeMachines rebuilds the whole file, so
    // that would delete every other machine's mapping. machines.yaml sits in
    // the store root and is git-synced, so conflict markers are the likely
    // cause — exactly the case where the other entries still matter. Same
    // contract as store-registry's readRegistryForMutation.
    //
    // "No mappings yet" is not the same thing: the shipped starter file is all
    // comments, which yaml.load resolves to null and listMachines reports as
    // MALFORMED_YAML. That file is fine to write into.
    if (!current.ok && current.code !== PhrenError.FILE_NOT_FOUND && hasMachineEntries(machinesPath)) {
      return phrenErr(
        `${machinesPath} exists but could not be read — refusing to rewrite it (that would drop the mappings phren cannot parse). ` +
          `Fix the file by hand (check for git conflict markers), then map again. Problem: ${current.error}`,
        PhrenError.MALFORMED_YAML,
      );
    }
    const data = current.ok ? current.data : {};
    data[machine] = profile;
    writeMachines(phrenPath, data);
    return phrenOk(`Mapped machine ${machine} -> ${profile}.`);
  });
}

/** Does machines.yaml hold anything beyond comments and blank lines? */
function hasMachineEntries(machinesPath: string): boolean {
  try {
    return fs
      .readFileSync(machinesPath, "utf8")
      .split("\n")
      .some((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  } catch {
    return false;
  }
}


function pickEnumVal<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

function pickFiniteNum(value: unknown): number | undefined {
  return typeof value === "number" && isFinite(value) ? value : undefined;
}

function parseProfilePolicyDefaults(raw: unknown): ProfilePolicyDefaults | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const data = raw as Record<string, unknown>;

  const retentionRaw = data.retentionPolicy && typeof data.retentionPolicy === "object" && !Array.isArray(data.retentionPolicy)
    ? data.retentionPolicy as Record<string, unknown>
    : undefined;
  const decayRaw = retentionRaw?.decay && typeof retentionRaw.decay === "object" && !Array.isArray(retentionRaw.decay)
    ? retentionRaw.decay as Record<string, unknown>
    : undefined;

  const workflowRaw = data.workflowPolicy && typeof data.workflowPolicy === "object" && !Array.isArray(data.workflowPolicy)
    ? data.workflowPolicy as Record<string, unknown>
    : undefined;

  const result: ProfilePolicyDefaults = {};

  const fs_ = pickEnumVal(data.findingSensitivity, VALID_FINDING_SENSITIVITY);
  if (fs_) result.findingSensitivity = fs_;
  const pr = pickEnumVal(data.proactivity, VALID_PROACTIVITY_LEVELS);
  if (pr) result.proactivity = pr;
  const prf = pickEnumVal(data.proactivityFindings, VALID_PROACTIVITY_LEVELS);
  if (prf) result.proactivityFindings = prf;
  const prt = pickEnumVal(data.proactivityTask, VALID_PROACTIVITY_LEVELS);
  if (prt) result.proactivityTask = prt;
  const tm = pickEnumVal(data.taskMode, VALID_TASK_MODES);
  if (tm) result.taskMode = tm;

  if (retentionRaw) {
    const ret: ProfilePolicyDefaults["retentionPolicy"] = {};
    const ttlDays = pickFiniteNum(retentionRaw.ttlDays);
    if (ttlDays !== undefined) ret.ttlDays = ttlDays;
    const retentionDays = pickFiniteNum(retentionRaw.retentionDays);
    if (retentionDays !== undefined) ret.retentionDays = retentionDays;
    const aat = pickFiniteNum(retentionRaw.autoAcceptThreshold);
    if (aat !== undefined) ret.autoAcceptThreshold = aat;
    const mic = pickFiniteNum(retentionRaw.minInjectConfidence);
    if (mic !== undefined) ret.minInjectConfidence = mic;
    if (decayRaw) {
      const decay: NonNullable<ProfilePolicyDefaults["retentionPolicy"]>["decay"] = {};
      const d30 = pickFiniteNum(decayRaw.d30); if (d30 !== undefined) decay.d30 = d30;
      const d60 = pickFiniteNum(decayRaw.d60); if (d60 !== undefined) decay.d60 = d60;
      const d90 = pickFiniteNum(decayRaw.d90); if (d90 !== undefined) decay.d90 = d90;
      const d120 = pickFiniteNum(decayRaw.d120); if (d120 !== undefined) decay.d120 = d120;
      if (Object.keys(decay).length > 0) ret.decay = decay;
    }
    if (Object.keys(ret).length > 0) result.retentionPolicy = ret;
  }

  if (workflowRaw) {
    const wf: ProfilePolicyDefaults["workflowPolicy"] = {};
    const lct = pickFiniteNum(workflowRaw.lowConfidenceThreshold);
    if (lct !== undefined) wf.lowConfidenceThreshold = lct;
    if (Array.isArray(workflowRaw.riskySections)) {
      const rs = (workflowRaw.riskySections as unknown[])
        .filter((s): s is "Review" | "Stale" | "Conflicts" =>
          typeof s === "string" && VALID_RISKY_SECTIONS.includes(s as "Review" | "Stale" | "Conflicts")
        );
      if (rs.length > 0) wf.riskySections = rs;
    }
    if (Object.keys(wf).length > 0) result.workflowPolicy = wf;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function getActiveProfileDefaults(phrenPath: string, profile?: string): ProfilePolicyDefaults | undefined {
  const profiles = listProfiles(phrenPath);
  if (!profiles.ok) return undefined;
  const activeName = profile ?? profiles.data[0]?.name;
  if (!activeName) return undefined;
  return profiles.data.find((p) => p.name === activeName)?.defaults;
}

export function listProfiles(phrenPath: string): PhrenResult<ProfileInfo[]> {
  const profilesDir = path.join(phrenPath, "profiles");
  if (!fs.existsSync(profilesDir)) return phrenErr(`No profiles/ directory found. Run 'phren init' to set up your phren.`, PhrenError.FILE_NOT_FOUND);
  const files = fs.readdirSync(profilesDir).filter((file) => file.endsWith(".yaml")).sort();
  const profiles: ProfileInfo[] = [];

  for (const file of files) {
    const full = path.join(profilesDir, file);
    try {
      const raw = fs.readFileSync(full, "utf8");
      const parsed = yaml.load(raw, { schema: yaml.CORE_SCHEMA });
      const data = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
      const name = (typeof data?.name === "string" && data.name.trim())
        ? data.name
        : file.replace(/\.yaml$/, "");
      const projects = Array.isArray(data?.projects)
        ? (data.projects as unknown[]).map((project) => String(project)).filter(Boolean)
        : [];
      const description = typeof data?.description === "string" ? data.description : undefined;
      const defaults = parseProfilePolicyDefaults(data?.defaults);
      profiles.push({ name, ...(description ? { description } : {}), file: full, projects, ...(defaults ? { defaults } : {}) });
    } catch (err: unknown) {
      logger.debug("profile-store", `listProfiles yamlParse: ${errorMessage(err)}`);
      return phrenErr(`profiles/${file}`, PhrenError.MALFORMED_YAML);
    }
  }

  return phrenOk(profiles);
}

/**
 * Rewrite a profile's `projects` list, preserving everything else in the file.
 *
 * Read-modify-write of the parsed document rather than a fresh dump of the three
 * fields the caller happens to know about: a profile also carries a `defaults:`
 * policy block (findingSensitivity, proactivity, retention/decay, workflow) that
 * getActiveProfileDefaults reads, plus any key a future version adds. Rebuilding
 * from scratch silently reverted the user's governance config to global defaults
 * on every `:profile add`/`remove` — and project rename is remove-then-add, so
 * the second write overwrote the .bak with the already-stripped copy.
 *
 * The leading comment block is re-attached the same way writeMachines does.
 */
function writeProfile(file: string, name: string, projects: string[], description?: string): void {
  const backup = `${file}.bak`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (existing) fs.copyFileSync(file, backup);

  let preserved: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = yaml.load(existing, { schema: yaml.CORE_SCHEMA });
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        preserved = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Unparsable file: listProfiles already refused it upstream, so callers
      // never reach here with one. Fall back to the minimal document.
    }
  }
  delete preserved.name;
  delete preserved.description;
  delete preserved.projects;

  const headerLines: string[] = [];
  for (const line of existing.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") {
      headerLines.push(line);
      continue;
    }
    break;
  }
  const header = headerLines.length ? `${headerLines.join("\n").replace(/\n+$/, "")}\n` : "";

  const normalized = [...new Set(projects)].sort();
  const out = yaml.dump(
    { name, ...(description ? { description } : {}), projects: normalized, ...preserved },
    { lineWidth: 1000 },
  );
  const tmpPath = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, header + out);
  fs.renameSync(tmpPath, file);
}

export function addProjectToProfile(phrenPath: string, profile: string, project: string): PhrenResult<string> {
  if (!isValidProjectName(project)) return phrenErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, PhrenError.INVALID_PROJECT_NAME);
  const profiles = listProfiles(phrenPath);
  if (!profiles.ok) return forwardErr(profiles);
  const current = profiles.data.find((entry) => entry.name === profile);
  if (!current) return phrenErr(`Profile "${profile}" not found.`, PhrenError.NOT_FOUND);

  return withSafeLock(current.file, () => {
    const refreshed = listProfiles(phrenPath);
    if (!refreshed.ok) return forwardErr(refreshed);
    const latest = refreshed.data.find((entry) => entry.name === profile);
    if (!latest) return phrenErr(`Profile "${profile}" not found.`, PhrenError.NOT_FOUND);

    const projects = latest.projects.includes(project) ? latest.projects : [...latest.projects, project];
    writeProfile(latest.file, latest.name, projects, latest.description);
    return phrenOk(`Added ${project} to profile ${profile}.`);
  });
}

export function removeProjectFromProfile(phrenPath: string, profile: string, project: string): PhrenResult<string> {
  const profiles = listProfiles(phrenPath);
  if (!profiles.ok) return forwardErr(profiles);
  const current = profiles.data.find((entry) => entry.name === profile);
  if (!current) return phrenErr(`Profile "${profile}" not found.`, PhrenError.NOT_FOUND);

  return withSafeLock(current.file, () => {
    const refreshed = listProfiles(phrenPath);
    if (!refreshed.ok) return forwardErr(refreshed);
    const latest = refreshed.data.find((entry) => entry.name === profile);
    if (!latest) return phrenErr(`Profile "${profile}" not found.`, PhrenError.NOT_FOUND);

    const projects = latest.projects.filter((entry) => entry !== project);
    writeProfile(latest.file, latest.name, projects, latest.description);
    return phrenOk(`Removed ${project} from profile ${profile}.`);
  });
}

function buildProjectCard(dir: string): ProjectCard {
  const name = path.basename(dir);
  const summaryFile = path.join(dir, "summary.md");
  const claudeFile = path.join(dir, "CLAUDE.md");
  const summarySource = fs.existsSync(summaryFile)
    ? fs.readFileSync(summaryFile, "utf8")
    : fs.existsSync(claudeFile)
      ? fs.readFileSync(claudeFile, "utf8")
      : "";
  const summary = summarySource
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#")) || "";
  const docs = ["CLAUDE.md", FINDINGS_FILENAME, "summary.md", "review.md"]
    .filter((file) => fs.existsSync(path.join(dir, file)));
  const taskFile = TASK_FILE_ALIASES.find((file) => fs.existsSync(path.join(dir, file)));
  if (taskFile) docs.push(taskFile);
  return { name, summary, docs };
}

export function listProjectCards(phrenPath: string, profile?: string): ProjectCard[] {
  const dirs = getProjectDirs(phrenPath, profile).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const cards: ProjectCard[] = dirs.map(buildProjectCard);

  const seen = new Set(dirs.map((d) => path.basename(d)));

  // Include projects from team stores, filtered by active profile
  try {
    // Resolve the profile's project allow-list (if any)
    let profileProjectNames: Set<string> | undefined;
    if (profile) {
      const profiles = listProfiles(phrenPath);
      if (profiles.ok) {
        const active = profiles.data.find((p) => p.name === profile);
        if (active && active.projects.length > 0) {
          profileProjectNames = new Set(active.projects);
        }
      }
    }

    for (const store of getNonPrimaryStores(phrenPath)) {
      if (!fs.existsSync(store.path)) continue;
      for (const dir of getStoreProjectDirs(store)) {
        const name = path.basename(dir);
        if (seen.has(name) || name === "global") continue;
        if (profileProjectNames && !profileProjectNames.has(name)) continue;
        seen.add(name);
        cards.push(buildProjectCard(dir));
      }
    }
  } catch {
    // store-registry not available or error loading, continue with primary only
  }

  // Prepend global as a pinned entry so it's always accessible from the shell
  const globalDir = path.join(phrenPath, "global");
  if (fs.existsSync(globalDir)) {
    cards.unshift(buildProjectCard(globalDir));
  }

  return cards;
}
