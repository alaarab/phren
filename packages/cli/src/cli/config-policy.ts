import { getPhrenPath } from "../shared.js";
import {
  getIndexPolicy,
  updateIndexPolicy,
  getRetentionPolicy,
  updateRetentionPolicy,
  getWorkflowPolicy,
  updateWorkflowPolicy,
  mergeConfig,
  VALID_TASK_MODES,
  VALID_FINDING_SENSITIVITY,
  type FindingSensitivityLevel,
} from "../shared/governance.js";
import { updateProjectConfigOverrides } from "../project-config.js";
import { isValidProjectName } from "../utils.js";
import { parseProjectArg, warnIfUnregistered } from "./config-shared.js";

// ── Finding sensitivity config ────────────────────────────────────────────────

export const FINDING_SENSITIVITY_CONFIG: Record<FindingSensitivityLevel, {
  sessionCap: number;
  proactivityFindings: string;
  agentInstruction: string;
}> = {
  minimal: {
    sessionCap: 0,
    proactivityFindings: "low",
    agentInstruction: "Only save findings when the user explicitly asks you to remember something.",
  },
  conservative: {
    sessionCap: 3,
    proactivityFindings: "medium",
    agentInstruction: "Save decisions and pitfalls only — skip patterns and observations.",
  },
  balanced: {
    sessionCap: 10,
    proactivityFindings: "high",
    agentInstruction: "Save non-obvious patterns, decisions, pitfalls, and bugs worth remembering next session.",
  },
  aggressive: {
    sessionCap: 20,
    proactivityFindings: "high",
    agentInstruction: "Save everything worth remembering — err on the side of capturing.",
  },
};

// ── Generic workflow field handler ────────────────────────────────────────────

interface WorkflowFieldHandlerOpts<T extends string> {
  fieldName: string;
  validValues: readonly T[];
  normalize: (raw: string | undefined) => T | null;
  getSnapshot: (phrenPath: string) => Record<string, unknown>;
  getProjectValue: (resolved: ReturnType<typeof mergeConfig>) => T;
  formatProjectOutput: (projectArg: string, value: T) => Record<string, unknown>;
  workflowPatchKey: string;
  projectOverrideKey: string;
}

function handleWorkflowField<T extends string>(args: string[], opts: WorkflowFieldHandlerOpts<T>) {
  const phrenPath = getPhrenPath();
  const { project: projectArg, rest: filteredArgs } = parseProjectArg(args);
  const action = filteredArgs[0];

  if (!action || action === "get") {
    if (projectArg) {
      if (!isValidProjectName(projectArg)) {
        console.error(`Invalid project name: "${projectArg}"`);
        process.exit(1);
      }
      const resolved = mergeConfig(phrenPath, projectArg);
      const value = opts.getProjectValue(resolved);
      console.log(JSON.stringify(opts.formatProjectOutput(projectArg, value), null, 2));
      return;
    }
    console.log(JSON.stringify(opts.getSnapshot(phrenPath), null, 2));
    return;
  }

  const applyValue = (value: T) => {
    if (projectArg) {
      if (!isValidProjectName(projectArg)) {
        console.error(`Invalid project name: "${projectArg}"`);
        process.exit(1);
      }
      warnIfUnregistered(phrenPath, projectArg);
      updateProjectConfigOverrides(phrenPath, projectArg, (current) => ({ ...current, [opts.projectOverrideKey]: value }));
      const resolved = mergeConfig(phrenPath, projectArg);
      const eff = opts.getProjectValue(resolved);
      console.log(JSON.stringify(opts.formatProjectOutput(projectArg, eff), null, 2));
      return;
    }
    const result = updateWorkflowPolicy(phrenPath, { [opts.workflowPatchKey]: value });
    if (!result.ok) {
      console.error(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(opts.getSnapshot(phrenPath), null, 2));
  };

  if (action === "set") {
    const value = opts.normalize(filteredArgs[1]);
    if (!value) {
      console.error(`Usage: phren config ${opts.fieldName} set [${opts.validValues.join("|")}]`);
      process.exit(1);
    }
    return applyValue(value);
  }

  const value = opts.normalize(action);
  if (value) return applyValue(value);

  console.error(`Usage: phren config ${opts.fieldName} [--project <name>] [get|set <value>|<value>]  — values: ${opts.validValues.join("|")}`);
  process.exit(1);
}

function normalizeFromList<T extends string>(raw: string | undefined, validValues: readonly T[]): T | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  return validValues.includes(lower as T) ? lower as T : null;
}

export function handleConfigTaskMode(args: string[]) {
  handleWorkflowField(args, {
    fieldName: "task-mode",
    validValues: VALID_TASK_MODES,
    normalize: (raw) => normalizeFromList(raw, VALID_TASK_MODES),
    getSnapshot: (phrenPath) => ({ taskMode: getWorkflowPolicy(phrenPath).taskMode }),
    getProjectValue: (resolved) => resolved.taskMode,
    formatProjectOutput: (proj, value) => ({ _project: proj, taskMode: value }),
    workflowPatchKey: "taskMode",
    projectOverrideKey: "taskMode",
  });
}

export function handleConfigFindingSensitivity(args: string[]) {
  handleWorkflowField(args, {
    fieldName: "finding-sensitivity",
    validValues: VALID_FINDING_SENSITIVITY,
    normalize: (raw) => normalizeFromList(raw, VALID_FINDING_SENSITIVITY),
    getSnapshot: (phrenPath) => {
      const policy = getWorkflowPolicy(phrenPath);
      const level = policy.findingSensitivity;
      return { level, ...FINDING_SENSITIVITY_CONFIG[level] };
    },
    getProjectValue: (resolved) => resolved.findingSensitivity,
    formatProjectOutput: (proj, value) => ({ _project: proj, level: value, ...FINDING_SENSITIVITY_CONFIG[value] }),
    workflowPatchKey: "findingSensitivity",
    projectOverrideKey: "findingSensitivity",
  });
}

// ── Index policy ─────────────────────────────────────────────────────────────

export async function handleIndexPolicy(args: string[]) {
  if (!args.length || args[0] === "get") {
    console.log(JSON.stringify(getIndexPolicy(getPhrenPath()), null, 2));
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
    const result = updateIndexPolicy(getPhrenPath(), patch);
    if (!result.ok) {
      console.error(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }
  console.error("Usage: phren index-policy [get|set --include=**/*.md,**/skills/**/*.md,.claude/skills/**/*.md --exclude=**/node_modules/**,**/.git/** --includeHidden=false]");
  process.exit(1);
}

// ── Memory policy ────────────────────────────────────────────────────────────

export async function handleRetentionPolicy(args: string[]) {
  const phrenPath = getPhrenPath();
  const { project: projectArg, rest: filteredArgs } = parseProjectArg(args);

  if (!filteredArgs.length || filteredArgs[0] === "get") {
    if (projectArg) {
      if (!isValidProjectName(projectArg)) {
        console.error(`Invalid project name: "${projectArg}"`);
        process.exit(1);
      }
      const resolved = mergeConfig(phrenPath, projectArg);
      console.log(JSON.stringify({ _project: projectArg, ...resolved.retentionPolicy }, null, 2));
      return;
    }
    console.log(JSON.stringify(getRetentionPolicy(phrenPath), null, 2));
    const conflictOn = process.env.PHREN_FEATURE_SEMANTIC_CONFLICT === "1";
    process.stderr.write(`\nDedup: free Jaccard similarity scan on every add_finding (no API key needed).\n`);
    process.stderr.write(`  Near-matches (30–55% overlap) are returned in the response for the agent to decide.\n`);
    if (conflictOn) {
      process.stderr.write(`\nConflict detection (PHREN_FEATURE_SEMANTIC_CONFLICT=1): active.\n`);
      process.stderr.write(`  Uses an LLM for batch conflict checks. See: phren config llm\n`);
    } else {
      process.stderr.write(`\nConflict detection: disabled (set PHREN_FEATURE_SEMANTIC_CONFLICT=1 to enable for batch ops).\n`);
      process.stderr.write(`  LLM needed only for batch operations (phren maintain consolidate/extract).\n`);
    }
    return;
  }
  if (filteredArgs[0] === "set") {
    if (projectArg) {
      if (!isValidProjectName(projectArg)) {
        console.error(`Invalid project name: "${projectArg}"`);
        process.exit(1);
      }
      warnIfUnregistered(phrenPath, projectArg);
      updateProjectConfigOverrides(phrenPath, projectArg, (current) => {
        const existingRetention = current.retentionPolicy ?? {};
        const retentionPatch: NonNullable<typeof existingRetention> = { ...existingRetention };
        for (const arg of filteredArgs.slice(1)) {
          if (!arg.startsWith("--")) continue;
          const [k, v] = arg.slice(2).split("=");
          if (!k || v === undefined) continue;
          const num = Number(v);
          const value = Number.isNaN(num) ? v : num;
          if (k.startsWith("decay.")) {
            retentionPatch.decay = { ...(retentionPatch.decay ?? {}) };
            (retentionPatch.decay as Record<string, unknown>)[k.slice("decay.".length)] = value;
          } else {
            (retentionPatch as Record<string, unknown>)[k] = value;
          }
        }
        return { ...current, retentionPolicy: retentionPatch };
      });
      const resolved = mergeConfig(phrenPath, projectArg);
      console.log(JSON.stringify({ _project: projectArg, ...resolved.retentionPolicy }, null, 2));
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const arg of filteredArgs.slice(1)) {
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
    const result = updateRetentionPolicy(phrenPath, patch);
    if (!result.ok) {
      console.error(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }
  console.error("Usage: phren config policy [--project <name>] [get|set --ttlDays=120 --retentionDays=365 --autoAcceptThreshold=0.75 --minInjectConfidence=0.35 --decay.d30=1 --decay.d60=0.85 --decay.d90=0.65 --decay.d120=0.45]");
  process.exit(1);
}

// ── Memory workflow ──────────────────────────────────────────────────────────

export async function handleWorkflowPolicy(args: string[]) {
  const phrenPath = getPhrenPath();
  const { project: projectArg, rest: filteredArgs } = parseProjectArg(args);

  if (!filteredArgs.length || filteredArgs[0] === "get") {
    if (projectArg) {
      if (!isValidProjectName(projectArg)) {
        console.error(`Invalid project name: "${projectArg}"`);
        process.exit(1);
      }
      const resolved = mergeConfig(phrenPath, projectArg);
      console.log(JSON.stringify({ _project: projectArg, ...resolved.workflowPolicy }, null, 2));
      return;
    }
    console.log(JSON.stringify(getWorkflowPolicy(phrenPath), null, 2));
    return;
  }
  if (filteredArgs[0] === "set") {
    if (projectArg) {
      if (!isValidProjectName(projectArg)) {
        console.error(`Invalid project name: "${projectArg}"`);
        process.exit(1);
      }
      warnIfUnregistered(phrenPath, projectArg);
      updateProjectConfigOverrides(phrenPath, projectArg, (current) => {
        const nextConfig = { ...current };
        const existingWorkflow = current.workflowPolicy ?? {};
        const workflowPatch: Record<string, unknown> = { ...existingWorkflow };
        for (const arg of filteredArgs.slice(1)) {
          if (!arg.startsWith("--")) continue;
          const [k, v] = arg.slice(2).split("=");
          if (!k || v === undefined) continue;
          if (k === "riskySections") {
            workflowPatch.riskySections = v.split(",").map((s) => s.trim()).filter(Boolean);
          } else if (k === "taskMode") {
            nextConfig.taskMode = v as typeof nextConfig.taskMode;
          } else if (k === "findingSensitivity") {
            nextConfig.findingSensitivity = v as typeof nextConfig.findingSensitivity;
          } else {
            const num = Number(v);
            workflowPatch[k] = Number.isNaN(num) ? v : num;
          }
        }
        if (Object.keys(workflowPatch).length > 0 || existingWorkflow !== current.workflowPolicy) {
          nextConfig.workflowPolicy = workflowPatch as typeof nextConfig.workflowPolicy;
        }
        return nextConfig;
      });
      const resolved = mergeConfig(phrenPath, projectArg);
      console.log(JSON.stringify({ _project: projectArg, ...resolved.workflowPolicy }, null, 2));
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const arg of filteredArgs.slice(1)) {
      if (!arg.startsWith("--")) continue;
      const [k, v] = arg.slice(2).split("=");
      if (!k || v === undefined) continue;
      if (k === "riskySections") {
        patch.riskySections = v.split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        const num = Number(v);
        patch[k] = Number.isNaN(num) ? v : num;
      }
    }
    const result = updateWorkflowPolicy(phrenPath, patch);
    if (!result.ok) {
      console.log(result.error);
      if (result.code === "PERMISSION_DENIED") process.exit(1);
      return;
    }
    console.log(JSON.stringify(result.data, null, 2));
    return;
  }
  console.error("Usage: phren config workflow [--project <name>] [get|set --lowConfidenceThreshold=0.7 --riskySections=Stale,Conflicts --taskMode=manual]");
  process.exit(1);
}
