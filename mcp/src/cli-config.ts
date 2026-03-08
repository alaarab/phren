import { ensureCortexPath } from "./shared.js";
import {
  getIndexPolicy,
  updateIndexPolicy,
  getRetentionPolicy,
  updateRetentionPolicy,
  getWorkflowPolicy,
  updateWorkflowPolicy,
  getAccessControl,
  updateAccessControl,
} from "./shared-governance.js";
import { listMachines as listMachinesStore, listProfiles as listProfilesStore } from "./data-access.js";
import { setTelemetryEnabled, getTelemetrySummary, resetTelemetry } from "./telemetry.js";

let _cortexPath: string | undefined;
function getCortexPath(): string {
  if (!_cortexPath) _cortexPath = ensureCortexPath();
  return _cortexPath;
}
// ── Config router ────────────────────────────────────────────────────────────

export async function handleConfig(args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "policy":
      return handleRetentionPolicy(rest);
    case "workflow":
      return handleWorkflowPolicy(rest);
    case "access":
      return handleAccessControl(rest);
    case "index":
      return handleIndexPolicy(rest);
    case "machines":
      return handleConfigMachines();
    case "profiles":
      return handleConfigProfiles();
    case "telemetry":
      return handleConfigTelemetry(rest);
    default:
      console.log(`cortex config - manage settings and policies

Subcommands:
  cortex config policy [get|set ...]     Memory retention, TTL, confidence, decay
  cortex config workflow [get|set ...]   Approval gates, risky-memory thresholds
  cortex config access [get|set ...]     Role-based permissions (admin/maintainer/contributor/viewer)
  cortex config index [get|set ...]      Indexer include/exclude globs
  cortex config machines                 Registered machines and profiles
  cortex config profiles                 All profiles and their projects
  cortex config telemetry [on|off|reset] Local usage stats (opt-in, no external reporting)`);
      if (sub) {
        console.error(`\nUnknown config subcommand: "${sub}"`);
        process.exit(1);
      }
  }
}

// ── Index policy ─────────────────────────────────────────────────────────────

export async function handleIndexPolicy(args: string[]) {
  if (!args.length || args[0] === "get") {
    console.log(JSON.stringify(getIndexPolicy(getCortexPath()), null, 2));
    return;
  }
  if (args[0] === "set") {
    const patch: {
      includeGlobs?: string[];
      excludeGlobs?: string[];
      includeHidden?: boolean;
    } = {};
    for (const arg of args.slice(1)) {
      if (!arg.startsWith("--")) continue;
      const [k, v] = arg.slice(2).split("=");
      if (!k || v === undefined) continue;
      if (k === "include") {
        patch.includeGlobs = v.split(",").map((s) => s.trim()).filter(Boolean);
      } else if (k === "exclude") {
        patch.excludeGlobs = v.split(",").map((s) => s.trim()).filter(Boolean);
      } else if (k === "includeHidden") {
        patch.includeHidden = /^(1|true|yes|on)$/i.test(v);
      }
    }
    const result = updateIndexPolicy(getCortexPath(), patch);
    if (!result.ok) {
      console.log(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }
  console.error("Usage: cortex index-policy [get|set --include=**/*.md,.claude/skills/**/*.md --exclude=**/node_modules/**,**/.git/** --includeHidden=false]");
  process.exit(1);
}

// ── Memory policy ────────────────────────────────────────────────────────────

export async function handleRetentionPolicy(args: string[]) {
  if (!args.length || args[0] === "get") {
    console.log(JSON.stringify(getRetentionPolicy(getCortexPath()), null, 2));
    return;
  }
  if (args[0] === "set") {
    const patch: Record<string, unknown> = {};
    for (const arg of args.slice(1)) {
      if (!arg.startsWith("--")) continue;
      const [k, v] = arg.slice(2).split("=");
      if (!k || v === undefined) continue;
      const num = Number(v);
      const value = Number.isNaN(num) ? v : num;
      if (k.startsWith("decay.")) {
        patch.decay = patch.decay || {};
        (patch.decay as Record<string, unknown>)[k.slice("decay.".length)] = value;
      } else {
        patch[k] = value;
      }
    }
    const result = updateRetentionPolicy(getCortexPath(), patch);
    if (!result.ok) {
      console.log(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }
  console.error("Usage: cortex config policy [get|set --ttlDays=120 --retentionDays=365 --autoAcceptThreshold=0.75 --minInjectConfidence=0.35 --decay.d30=1 --decay.d60=0.85 --decay.d90=0.65 --decay.d120=0.45]");
  process.exit(1);
}

// ── Memory workflow ──────────────────────────────────────────────────────────

export async function handleWorkflowPolicy(args: string[]) {
  if (!args.length || args[0] === "get") {
    console.log(JSON.stringify(getWorkflowPolicy(getCortexPath()), null, 2));
    return;
  }
  if (args[0] === "set") {
    const patch: Record<string, unknown> = {};
    for (const arg of args.slice(1)) {
      if (!arg.startsWith("--")) continue;
      const [k, v] = arg.slice(2).split("=");
      if (!k || v === undefined) continue;
      if (k === "requireMaintainerApproval") {
        patch.requireMaintainerApproval = /^(1|true|yes|on)$/i.test(v);
      } else if (k === "riskySections") {
        patch.riskySections = v.split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        const num = Number(v);
        patch[k] = Number.isNaN(num) ? v : num;
      }
    }
    const result = updateWorkflowPolicy(getCortexPath(), patch);
    if (!result.ok) {
      console.log(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }
  console.error("Usage: cortex config workflow [get|set --requireMaintainerApproval=true --lowConfidenceThreshold=0.7 --riskySections=Stale,Conflicts]");
  process.exit(1);
}

// ── Memory access ────────────────────────────────────────────────────────────

export async function handleAccessControl(args: string[]) {
  if (!args.length || args[0] === "get") {
    console.log(JSON.stringify(getAccessControl(getCortexPath()), null, 2));
    return;
  }
  if (args[0] === "set") {
    const patch: Record<string, unknown> = {};
    for (const arg of args.slice(1)) {
      if (!arg.startsWith("--")) continue;
      const [k, v] = arg.slice(2).split("=");
      if (!k || v === undefined) continue;
      patch[k] = v.split(",").map((s) => s.trim()).filter(Boolean);
    }
    const result = updateAccessControl(getCortexPath(), patch);
    if (!result.ok) {
      console.log(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }
  console.error("Usage: cortex config access [get|set --admins=u1,u2 --maintainers=u3 --contributors=u4 --viewers=u5]");
  process.exit(1);
}

// ── Machines and profiles ────────────────────────────────────────────────────

function handleConfigMachines() {
  const result = listMachinesStore(getCortexPath());
  if (!result.ok) {
    console.log(result.error);
    return;
  }
  const lines = Object.entries(result.data).map(([machine, prof]) => `  ${machine}: ${prof}`);
  console.log(`Registered Machines\n${lines.join("\n")}`);
}

function handleConfigProfiles() {
  const result = listProfilesStore(getCortexPath());
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
      setTelemetryEnabled(getCortexPath(), true);
      console.log("Telemetry enabled. Local usage stats will be collected.");
      console.log("No data is sent externally. Stats are stored in .runtime/telemetry.json.");
      return;
    case "off":
      setTelemetryEnabled(getCortexPath(), false);
      console.log("Telemetry disabled.");
      return;
    case "reset":
      resetTelemetry(getCortexPath());
      console.log("Telemetry stats reset.");
      return;
    default:
      console.log(getTelemetrySummary(getCortexPath()));
  }
}
