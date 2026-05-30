import { getPhrenPath, readRootManifest } from "../shared.js";
import { listMachines as listMachinesStore, listProfiles as listProfilesStore } from "../data/access.js";
import { setTelemetryEnabled, getTelemetrySummary, resetTelemetry } from "../telemetry.js";
import * as path from "path";
import { buildConfigView, type ConfigView } from "../config/resolve.js";
import { CONFIG_DOMAINS } from "../config/schema.js";
import { isValidProjectName } from "../utils.js";
import { parseProjectArg, checkProjectInProfile } from "./config-shared.js";
import { handleConfigProactivity, handleConfigProjectOwnership } from "./config-proactivity.js";
import {
  handleIndexPolicy,
  handleRetentionPolicy,
  handleWorkflowPolicy,
  handleConfigTaskMode,
  handleConfigFindingSensitivity,
} from "./config-policy.js";
import { handleConfigLlm } from "./config-llm.js";
import { handleConfigAccess } from "./config-access.js";
import { handleConfigSynonyms } from "./config-synonyms.js";

// Re-export the public surface so external importers (cli-registry.ts, tools/config.ts,
// tests) keep resolving the same names from "./cli/config.js" after the split.
export { checkProjectInProfile, handleIndexPolicy, handleRetentionPolicy, handleWorkflowPolicy, handleConfigAccess };
export { buildProactivitySnapshot } from "./config-proactivity.js";
export { FINDING_SENSITIVITY_CONFIG } from "./config-policy.js";

// ── Config show ───────────────────────────────────────────────────────────────

function formatConfigValue(value: unknown): string {
  if (value === undefined || value === null) return "(unset)";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "(none)";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/**
 * Render a resolved {@link ConfigView} grouped by domain, with a source column
 * that names where each value came from (default / global / project) and the
 * file that set it.
 */
function renderConfigView(view: ConfigView, opts: { diff: boolean }): void {
  const heading = view.scope === "project"
    ? `phren config — project: ${view.project}`
    : "phren config — global (applies to all projects unless overridden)";
  console.log(`\n${heading}`);
  if (opts.diff) console.log("(showing only values customised away from defaults)");

  let shownAny = false;
  for (const domain of CONFIG_DOMAINS) {
    const rows: Array<{ label: string; value: string; source: string }> = [];
    for (const field of domain.fields) {
      const resolved = view.fields[field.key];
      if (!resolved) continue; // topic fields are resolved separately
      if (opts.diff && resolved.source === "default") continue;
      const file = resolved.sourcePath ? path.basename(resolved.sourcePath) : "";
      rows.push({
        label: field.label,
        value: formatConfigValue(resolved.value),
        source: resolved.source === "default"
          ? "default"
          : `${resolved.source}${file ? ` (${file})` : ""}`,
      });
    }
    if (!rows.length) continue;
    shownAny = true;
    console.log(`\n${domain.label}  —  ${domain.summary}`);
    const labelW = Math.max(...rows.map((r) => r.label.length));
    const valueW = Math.max(...rows.map((r) => r.value.length), 6);
    for (const r of rows) {
      console.log(`  ${r.label.padEnd(labelW)}  ${r.value.padEnd(valueW)}  ${r.source}`);
    }
  }
  if (!shownAny) {
    console.log(opts.diff ? "\nEverything is at its default value." : "\n(no config)");
  }
  console.log("");
}

function handleConfigShow(args: string[]): void {
  const phrenPath = getPhrenPath();
  const { project: projectArg, rest } = parseProjectArg(args);
  const asJson = rest.includes("--json");
  const diff = rest.includes("--diff");

  if (projectArg && !isValidProjectName(projectArg)) {
    console.error(`Invalid project name: "${projectArg}"`);
    process.exit(1);
  }

  const view = buildConfigView(phrenPath, projectArg);

  if (asJson) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }

  renderConfigView(view, { diff });

  if (projectArg) {
    const notRegistered = checkProjectInProfile(phrenPath, projectArg);
    if (notRegistered) {
      console.error(`Run 'phren add /path/to/${projectArg}' to register this project.\n`);
    }
  } else {
    console.log("Tips: '--project <name>' for a project's merged config, '--diff' for only customised values, '--json' for machine-readable output.\n");
  }
}

// ── Config router ────────────────────────────────────────────────────────────

export async function handleConfig(args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "show":
      return handleConfigShow(rest);
    case "policy":
      return handleRetentionPolicy(rest);
    case "workflow":
      return handleWorkflowPolicy(rest);
    case "index":
      return handleIndexPolicy(rest);
    case "machines":
      return handleConfigMachines();
    case "profiles":
      return handleConfigProfiles();
    case "telemetry":
      return handleConfigTelemetry(rest);
    case "proactivity":
    case "proactivity.findings":
    case "proactivity.tasks":
      return handleConfigProactivity(sub, rest);
    case "project-ownership":
      return handleConfigProjectOwnership(rest);
    case "task-mode":
      return handleConfigTaskMode(rest);
    case "finding-sensitivity":
      return handleConfigFindingSensitivity(rest);
    case "access":
      return handleConfigAccess(rest);
    case "llm":
      return handleConfigLlm(rest);
    case "synonyms":
      return handleConfigSynonyms(rest);
    default:
      console.log(`phren config - manage settings and policies

Subcommands:
  phren config show [--project <name>] [--diff] [--json]
                                        Full merged config grouped by domain, with the
                                        source (default/global/project) of every value
  phren config policy [get|set ...]     Memory retention, TTL, confidence, decay
  phren config workflow [get|set ...]   Risky-memory thresholds, task automation mode
  phren config index [get|set ...]      Indexer include/exclude globs
  phren config proactivity [level]      Base auto-capture level (high|medium|low)
  phren config proactivity.findings [level]
                                        Findings-specific auto-capture level override
  phren config proactivity.tasks [level]
                                        Task-specific auto-capture level override
  phren config task-mode [get|set <mode>]
                                        Task automation mode (off|manual|suggest|auto)
  phren config finding-sensitivity [get|set <level>]
                                        Finding capture level (minimal|conservative|balanced|aggressive)
  phren config access [--project <name>] [get|set --admins=...]
                                        Role-based access lists (admins|contributors|readers)
  phren config project-ownership [mode]
                                        Default ownership for future project enrollments
  phren config llm [get|set model|endpoint|key]
                                        LLM config for semantic dedup/conflict features
  phren config synonyms [list|add|remove] ...
                                        Manage project learned synonyms
  phren config machines                 Registered machines and profiles
  phren config profiles                 All profiles and their projects
  phren config telemetry [on|off|reset] Local usage stats (opt-in, no external reporting)`);
      if (sub) {
        console.error(`\nUnknown config subcommand: "${sub}"`);
        process.exit(1);
      }
  }
}

// ── Machines and profiles ────────────────────────────────────────────────────

function handleConfigMachines() {
  const manifest = readRootManifest(getPhrenPath());
  if (manifest?.installMode === "project-local") {
    console.log("config machines is shared-mode only");
    return;
  }
  const result = listMachinesStore(getPhrenPath());
  if (!result.ok) {
    console.log(result.error);
    return;
  }
  const lines = Object.entries(result.data).map(([machine, prof]) => `  ${machine}: ${prof}`);
  console.log(`Registered Machines\n${lines.join("\n")}`);
}

function handleConfigProfiles() {
  const manifest = readRootManifest(getPhrenPath());
  if (manifest?.installMode === "project-local") {
    console.log("config profiles is shared-mode only");
    return;
  }
  const result = listProfilesStore(getPhrenPath());
  if (!result.ok) {
    console.log(result.error);
    return;
  }
  for (const p of result.data) {
    console.log(`\n${p.name}`);
    for (const proj of p.projects) console.log(`  - ${proj}`);
    if (!p.projects.length) console.log("  (no projects)");
  }
}

function handleConfigTelemetry(args: string[]) {
  const action = args[0];
  switch (action) {
    case "on":
      setTelemetryEnabled(getPhrenPath(), true);
      console.log("Telemetry enabled. Local usage stats will be collected.");
      console.log("No data is sent externally. Stats are stored in .runtime/telemetry.json.");
      return;
    case "off":
      setTelemetryEnabled(getPhrenPath(), false);
      console.log("Telemetry disabled.");
      return;
    case "reset":
      resetTelemetry(getPhrenPath());
      console.log("Telemetry stats reset.");
      return;
    default:
      console.log(getTelemetrySummary(getPhrenPath()));
  }
}
