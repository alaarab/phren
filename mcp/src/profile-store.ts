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
import { TASK_FILE_ALIASES } from "./data-tasks.js";
import { withSafeLock } from "./shared-data-utils.js";
import { logDebug } from "./logger.js";

export interface ProfilePolicyDefaults {
  findingSensitivity?: "minimal" | "conservative" | "balanced" | "aggressive";
  proactivity?: "high" | "medium" | "low";
  proactivityFindings?: "high" | "medium" | "low";
  proactivityTask?: "high" | "medium" | "low";
  taskMode?: "off" | "manual" | "suggest" | "auto";
  retentionPolicy?: {
    ttlDays?: number;
    retentionDays?: number;
    autoAcceptThreshold?: number;
    minInjectConfidence?: number;
    decay?: {
      d30?: number;
      d60?: number;
      d90?: number;
      d120?: number;
    };
  };
  workflowPolicy?: {
    lowConfidenceThreshold?: number;
    riskySections?: Array<"Review" | "Stale" | "Conflicts">;
  };
}

export interface ProfileInfo {
  name: string;
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
  return phrenOk(profiles.data[0]?.name);
}

export function listMachines(phrenPath: string): PhrenResult<Record<string, string>> {
  const machinesPath = path.join(phrenPath, "machines.yaml");
  if (!fs.existsSync(machinesPath)) return phrenErr(`machines.yaml not found. Run 'npx phren init' to set up your phren.`, PhrenError.FILE_NOT_FOUND);
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
    logDebug("listMachines yaml parse", errorMessage(err));
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
    const data = current.ok ? current.data : {};
    data[machine] = profile;
    writeMachines(phrenPath, data);
    return phrenOk(`Mapped machine ${machine} -> ${profile}.`);
  });
}

const VALID_FINDING_SENSITIVITY_VALS = ["minimal", "conservative", "balanced", "aggressive"] as const;
const VALID_PROACTIVITY_VALS = ["high", "medium", "low"] as const;
const VALID_TASK_MODE_VALS = ["off", "manual", "suggest", "auto"] as const;
const VALID_RISKY_SECTION_VALS = ["Review", "Stale", "Conflicts"] as const;

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

  const fs_ = pickEnumVal(data.findingSensitivity, VALID_FINDING_SENSITIVITY_VALS);
  if (fs_) result.findingSensitivity = fs_;
  const pr = pickEnumVal(data.proactivity, VALID_PROACTIVITY_VALS);
  if (pr) result.proactivity = pr;
  const prf = pickEnumVal(data.proactivityFindings, VALID_PROACTIVITY_VALS);
  if (prf) result.proactivityFindings = prf;
  const prt = pickEnumVal(data.proactivityTask, VALID_PROACTIVITY_VALS);
  if (prt) result.proactivityTask = prt;
  const tm = pickEnumVal(data.taskMode, VALID_TASK_MODE_VALS);
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
          typeof s === "string" && VALID_RISKY_SECTION_VALS.includes(s as "Review" | "Stale" | "Conflicts")
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
  if (!fs.existsSync(profilesDir)) return phrenErr(`No profiles/ directory found. Run 'npx phren init' to set up your phren.`, PhrenError.FILE_NOT_FOUND);
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
      const defaults = parseProfilePolicyDefaults(data?.defaults);
      profiles.push({ name, file: full, projects, ...(defaults ? { defaults } : {}) });
    } catch (err: unknown) {
      logDebug("listProfiles yamlParse", errorMessage(err));
      return phrenErr(`profiles/${file}`, PhrenError.MALFORMED_YAML);
    }
  }

  return phrenOk(profiles);
}

function writeProfile(file: string, name: string, projects: string[]): void {
  const backup = `${file}.bak`;
  if (fs.existsSync(file)) fs.copyFileSync(file, backup);
  const normalized = [...new Set(projects)].sort();
  const out = yaml.dump({ name, projects: normalized }, { lineWidth: 1000 });
  const tmpPath = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, out);
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
    writeProfile(latest.file, latest.name, projects);
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
    writeProfile(latest.file, latest.name, projects);
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
  const docs = ["CLAUDE.md", "FINDINGS.md", "summary.md", "review.md"]
    .filter((file) => fs.existsSync(path.join(dir, file)));
  const taskFile = TASK_FILE_ALIASES.find((file) => fs.existsSync(path.join(dir, file)));
  if (taskFile) docs.push(taskFile);
  return { name, summary, docs };
}

export function listProjectCards(phrenPath: string, profile?: string): ProjectCard[] {
  const dirs = getProjectDirs(phrenPath, profile).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const cards: ProjectCard[] = dirs.map(buildProjectCard);

  // Prepend global as a pinned entry so it's always accessible from the shell
  const globalDir = path.join(phrenPath, "global");
  if (fs.existsSync(globalDir)) {
    cards.unshift(buildProjectCard(globalDir));
  }

  return cards;
}
