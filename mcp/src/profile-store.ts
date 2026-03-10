import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as yaml from "js-yaml";
import {
  cortexErr,
  CortexError,
  cortexOk,
  type CortexResult,
  forwardErr,
  getProjectDirs,
} from "./shared.js";
import { defaultMachineName, getMachineName } from "./machine-identity.js";
import { withFileLock as withFileLockRaw } from "./shared-governance.js";
import { errorMessage, isValidProjectName } from "./utils.js";

function withSafeLock<T>(filePath: string, fn: () => CortexResult<T>): CortexResult<T> {
  try {
    return withFileLockRaw(filePath, fn);
  } catch (err: unknown) {
    const msg = errorMessage(err);
    if (msg.includes("could not acquire lock")) {
      return cortexErr(`Could not acquire write lock for "${path.basename(filePath)}". Another write may be in progress; please retry.`, CortexError.LOCK_TIMEOUT);
    }
    throw err;
  }
}

export interface ProfileInfo {
  name: string;
  file: string;
  projects: string[];
}

export interface ProjectCard {
  name: string;
  summary: string;
  docs: string[];
}

function parseLegacyProfile(raw: string, file: string): ProfileInfo | null {
  const nameMatch = raw.match(/^name:\s*(.+)\s*$/m);
  const projects = raw
    .split("\n")
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1] ?? null)
    .filter((entry): entry is string => Boolean(entry));
  if (!nameMatch || projects.length === 0) return null;
  return {
    name: nameMatch?.[1]?.trim() || file.replace(/\.yaml$/, ""),
    file,
    projects,
  };
}

export function resolveActiveProfile(cortexPath: string, requestedProfile?: string): CortexResult<string | undefined> {
  if (requestedProfile) {
    const profiles = listProfiles(cortexPath);
    if (!profiles.ok) return forwardErr(profiles);
    const exists = profiles.data.some((entry) => entry.name === requestedProfile);
    if (!exists) return cortexErr(`Profile "${requestedProfile}" not found.`, CortexError.NOT_FOUND);
    return cortexOk(requestedProfile);
  }

  const machines = listMachines(cortexPath);
  if (machines.ok) {
    const profiles = listProfiles(cortexPath);
    if (!profiles.ok) return forwardErr(profiles);
    const candidates = [getMachineName(), defaultMachineName()].filter((value, index, values) => value && values.indexOf(value) === index);
    for (const machineName of candidates) {
      const mapped = machines.data[machineName];
      if (!mapped) continue;
      const exists = profiles.data.some((entry) => entry.name === mapped);
      if (exists) return cortexOk(mapped);
    }
  }

  const profiles = listProfiles(cortexPath);
  if (!profiles.ok) return forwardErr(profiles);
  return cortexOk(profiles.data[0]?.name);
}

export function listMachines(cortexPath: string): CortexResult<Record<string, string>> {
  const machinesPath = path.join(cortexPath, "machines.yaml");
  if (!fs.existsSync(machinesPath)) return cortexErr(`machines.yaml not found. Run 'npx @alaarab/cortex init' to set up your cortex.`, CortexError.FILE_NOT_FOUND);
  try {
    const raw = fs.readFileSync(machinesPath, "utf8");
    const parsed = yaml.load(raw, { schema: yaml.CORE_SCHEMA });
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return cortexErr(`machines.yaml is empty or not valid YAML. Check the file format or run 'cortex doctor --fix'.`, CortexError.MALFORMED_YAML);

    const cleaned: Record<string, string> = {};
    for (const [machine, profile] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof machine !== "string" || !machine.trim()) continue;
      if (typeof profile !== "string" || !profile.trim()) continue;
      cleaned[machine] = profile;
    }
    return cortexOk(cleaned);
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] listMachines yaml parse: ${errorMessage(err)}\n`);
    return cortexErr(`Could not parse machines.yaml. Check the file for syntax errors or run 'cortex doctor --fix'.`, CortexError.MALFORMED_YAML);
  }
}

function writeMachines(cortexPath: string, data: Record<string, string>): void {
  const machinesPath = path.join(cortexPath, "machines.yaml");
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

export function setMachineProfile(cortexPath: string, machine: string, profile: string): CortexResult<string> {
  if (!machine || !profile) return cortexErr(`Both machine name and profile name are required. Example: :machine map my-laptop personal`, CortexError.EMPTY_INPUT);

  const profiles = listProfiles(cortexPath);
  if (profiles.ok) {
    const exists = profiles.data.some((entry) => entry.name === profile);
    if (!exists) return cortexErr(`Profile "${profile}" does not exist. Check available profiles in the profiles/ directory.`, CortexError.NOT_FOUND);
  }

  const machinesPath = path.join(cortexPath, "machines.yaml");
  return withSafeLock(machinesPath, () => {
    const current = listMachines(cortexPath);
    const data = current.ok ? current.data : {};
    data[machine] = profile;
    writeMachines(cortexPath, data);
    return cortexOk(`Mapped machine ${machine} -> ${profile}.`);
  });
}

export function listProfiles(cortexPath: string): CortexResult<ProfileInfo[]> {
  const profilesDir = path.join(cortexPath, "profiles");
  if (!fs.existsSync(profilesDir)) return cortexErr(`No profiles/ directory found. Run 'npx @alaarab/cortex init' to set up your cortex.`, CortexError.FILE_NOT_FOUND);
  const files = fs.readdirSync(profilesDir).filter((file) => file.endsWith(".yaml")).sort();
  const profiles: ProfileInfo[] = [];

  for (const file of files) {
    const full = path.join(profilesDir, file);
    try {
      const raw = fs.readFileSync(full, "utf8");
      try {
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
        profiles.push({ name, file: full, projects });
      } catch (err: unknown) {
        const recovered = parseLegacyProfile(raw, full);
        if (recovered) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] listProfiles recovered legacy profile: ${full} (${errorMessage(err)})\n`);
          profiles.push(recovered);
          continue;
        }
        throw err;
      }
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] listProfiles yamlParse: ${errorMessage(err)}\n`);
      return cortexErr(`profiles/${file}`, CortexError.MALFORMED_YAML);
    }
  }

  return cortexOk(profiles);
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

export function addProjectToProfile(cortexPath: string, profile: string, project: string): CortexResult<string> {
  if (!isValidProjectName(project)) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);
  const profiles = listProfiles(cortexPath);
  if (!profiles.ok) return forwardErr(profiles);
  const current = profiles.data.find((entry) => entry.name === profile);
  if (!current) return cortexErr(`Profile "${profile}" not found.`, CortexError.NOT_FOUND);

  return withSafeLock(current.file, () => {
    const refreshed = listProfiles(cortexPath);
    if (!refreshed.ok) return forwardErr(refreshed);
    const latest = refreshed.data.find((entry) => entry.name === profile);
    if (!latest) return cortexErr(`Profile "${profile}" not found.`, CortexError.NOT_FOUND);

    const projects = latest.projects.includes(project) ? latest.projects : [...latest.projects, project];
    writeProfile(latest.file, latest.name, projects);
    return cortexOk(`Added ${project} to profile ${profile}.`);
  });
}

export function removeProjectFromProfile(cortexPath: string, profile: string, project: string): CortexResult<string> {
  const profiles = listProfiles(cortexPath);
  if (!profiles.ok) return forwardErr(profiles);
  const current = profiles.data.find((entry) => entry.name === profile);
  if (!current) return cortexErr(`Profile "${profile}" not found.`, CortexError.NOT_FOUND);

  return withSafeLock(current.file, () => {
    const refreshed = listProfiles(cortexPath);
    if (!refreshed.ok) return forwardErr(refreshed);
    const latest = refreshed.data.find((entry) => entry.name === profile);
    if (!latest) return cortexErr(`Profile "${profile}" not found.`, CortexError.NOT_FOUND);

    const projects = latest.projects.filter((entry) => entry !== project);
    writeProfile(latest.file, latest.name, projects);
    return cortexOk(`Removed ${project} from profile ${profile}.`);
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
  const docs = ["CLAUDE.md", "FINDINGS.md", "LEARNINGS.md", "summary.md", "backlog.md", "MEMORY_QUEUE.md"]
    .filter((file) => fs.existsSync(path.join(dir, file)));
  return { name, summary, docs };
}

export function listProjectCards(cortexPath: string, profile?: string): ProjectCard[] {
  const dirs = getProjectDirs(cortexPath, profile).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const cards: ProjectCard[] = dirs.map(buildProjectCard);

  // Prepend global as a pinned entry so it's always accessible from the shell
  const globalDir = path.join(cortexPath, "global");
  if (fs.existsSync(globalDir)) {
    cards.unshift(buildProjectCard(globalDir));
  }

  return cards;
}
