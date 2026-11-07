/**
 * Shared config schema — the single source of truth every surface renders from.
 *
 * The CLI (`phren config`), the Web UI settings tab, and the VS Code settings
 * webview all import these descriptors so their labels, help text, option lists,
 * defaults, and ranges can never drift apart.
 *
 * Each field is a {@link ConfigFieldDescriptor}; fields are grouped into the
 * nine {@link CONFIG_DOMAINS}. Nothing here renders UI — descriptors are pure
 * data so every surface can present them in its own idiom.
 */

import {
  DEFAULT_POLICY,
  DEFAULT_WORKFLOW_POLICY,
  DEFAULT_INDEX_POLICY,
} from "../governance/policy.js";
import { DEFAULT_DREAMING_CONFIG, DREAMING_RANGES } from "./dreaming.js";

/** The nine configurable domains, named to match the `get_config`/`set_config` MCP tools. */
export type ConfigDomainId =
  | "proactivity"
  | "taskMode"
  | "findingSensitivity"
  | "retention"
  | "workflow"
  | "index"
  | "topic"
  | "access"
  | "dreaming";

/** How a field's value is entered. Surfaces pick a widget from this. */
export type ConfigControl = "enum" | "number" | "boolean" | "string" | "string-list" | "object";

/** Where a field may be set. `global+project` fields support per-project overrides. */
export type ConfigScope = "global+project" | "global-only" | "project-only";

/** One choice for an `enum` field, with plain-English copy. */
export interface ConfigOption {
  value: string;
  label: string;
  /** One sentence explaining what choosing this does. */
  blurb: string;
  /** True for the safe default most users should keep. */
  recommended?: boolean;
}

/** A single configurable setting. */
export interface ConfigFieldDescriptor {
  /** Dotted, stable identifier — e.g. `retention.ttlDays`, `proactivity.base`. */
  key: string;
  domain: ConfigDomainId;
  /** Short human label. */
  label: string;
  /** One line shown inline next to the control. */
  summary: string;
  /** A paragraph shown on a help disclosure. */
  help: string;
  control: ConfigControl;
  /** Present for `enum` and `string-list` (constrained) fields. */
  options?: ConfigOption[];
  /** Present for `number` fields. */
  range?: { min: number; max: number; step: number };
  /** The value used when nothing is configured at any level. */
  default: unknown;
  scope: ConfigScope;
  /** Plain-English description of what changing this affects. */
  impact: string;
  /** `caution` fields trigger a confirm step before applying. */
  risk: "safe" | "caution";
}

/** A group of related fields. */
export interface ConfigDomainDescriptor {
  id: ConfigDomainId;
  label: string;
  /** A codicon-style icon name (used by VS Code; ignored elsewhere). */
  icon: string;
  summary: string;
  scope: ConfigScope;
  fields: ConfigFieldDescriptor[];
}

// ── Reusable option lists ─────────────────────────────────────────────────────

const PROACTIVITY_OPTIONS: ConfigOption[] = [
  {
    value: "high",
    label: "High",
    blurb: "The agent auto-captures eagerly without waiting for an explicit ask.",
    recommended: true,
  },
  {
    value: "medium",
    label: "Medium",
    blurb: "The agent only auto-captures when your message has an explicit signal (e.g. \"remember this\").",
  },
  {
    value: "low",
    label: "Low",
    blurb: "The agent never auto-captures — you drive every save yourself.",
  },
];

// ── Domain definitions ────────────────────────────────────────────────────────

export const CONFIG_DOMAINS: ConfigDomainDescriptor[] = [
  {
    id: "proactivity",
    label: "Proactivity",
    icon: "pulse",
    summary: "How eagerly the agent acts on its own to capture memory.",
    scope: "global+project",
    fields: [
      {
        key: "proactivity.base",
        domain: "proactivity",
        label: "Base proactivity",
        summary: "Master auto-capture level for both findings and tasks.",
        help:
          "Sets the default eagerness for everything the agent captures without being asked. "
          + "Findings and tasks each inherit this unless you override them below.",
        control: "enum",
        options: PROACTIVITY_OPTIONS,
        default: "high",
        scope: "global+project",
        impact: "Higher = more memories saved automatically; lower = you stay fully in control.",
        risk: "safe",
      },
      {
        key: "proactivity.findings",
        domain: "proactivity",
        label: "Findings proactivity",
        summary: "Auto-capture level for findings specifically.",
        help:
          "Overrides the base level just for findings (insights, decisions, pitfalls). "
          + "Leave unset to inherit the base level.",
        control: "enum",
        options: PROACTIVITY_OPTIONS,
        default: "high",
        scope: "global+project",
        impact: "Controls how often the agent writes to FINDINGS.md on its own.",
        risk: "safe",
      },
      {
        key: "proactivity.tasks",
        domain: "proactivity",
        label: "Tasks proactivity",
        summary: "Auto-capture level for tasks specifically.",
        help:
          "Overrides the base level just for tasks. Leave unset to inherit the base level.",
        control: "enum",
        options: PROACTIVITY_OPTIONS,
        default: "high",
        scope: "global+project",
        impact: "Controls how often the agent adds items to tasks.md on its own.",
        risk: "safe",
      },
    ],
  },
  {
    id: "taskMode",
    label: "Task mode",
    icon: "checklist",
    summary: "How much authority the agent has over your task list.",
    scope: "global+project",
    fields: [
      {
        key: "taskMode",
        domain: "taskMode",
        label: "Task mode",
        summary: "What the agent is allowed to do with tasks.",
        help:
          "Governs whether the agent may create, complete, and reorder tasks for you, "
          + "or whether task management stays entirely in your hands.",
        control: "enum",
        options: [
          {
            value: "auto",
            label: "Auto",
            blurb: "The agent freely creates, updates, and completes tasks as work progresses.",
            recommended: true,
          },
          {
            value: "suggest",
            label: "Suggest",
            blurb: "The agent proposes task changes but waits for you to confirm.",
          },
          {
            value: "manual",
            label: "Manual",
            blurb: "Only you create and change tasks; the agent never touches them.",
          },
          {
            value: "off",
            label: "Off",
            blurb: "Task tracking is disabled entirely.",
          },
        ],
        default: DEFAULT_WORKFLOW_POLICY.taskMode,
        scope: "global+project",
        impact: "`off` hides the task system completely; `auto` lets the agent run it.",
        risk: "caution",
      },
    ],
  },
  {
    id: "findingSensitivity",
    label: "Finding sensitivity",
    icon: "lightbulb",
    summary: "How selective the agent is about what counts as worth remembering.",
    scope: "global+project",
    fields: [
      {
        key: "findingSensitivity",
        domain: "findingSensitivity",
        label: "Finding sensitivity",
        summary: "The bar for what the agent saves as a finding.",
        help:
          "Sets both the per-session cap on auto-captured findings and the instruction the "
          + "agent follows about what is worth keeping.",
        control: "enum",
        options: [
          {
            value: "minimal",
            label: "Minimal",
            blurb: "Only save findings when the user explicitly asks you to remember something.",
          },
          {
            value: "conservative",
            label: "Conservative",
            blurb: "Save decisions and pitfalls only — skip patterns and observations.",
          },
          {
            value: "balanced",
            label: "Balanced",
            blurb: "Save non-obvious patterns, decisions, pitfalls, and bugs worth remembering next session.",
            recommended: true,
          },
          {
            value: "aggressive",
            label: "Aggressive",
            blurb: "Save everything worth remembering — err on the side of capturing.",
          },
        ],
        default: DEFAULT_WORKFLOW_POLICY.findingSensitivity,
        scope: "global+project",
        impact: "Higher = more findings per session (cap 0/3/10/20), larger context injection, more noise.",
        risk: "safe",
      },
    ],
  },
  {
    id: "retention",
    label: "Retention",
    icon: "archive",
    summary: "How long memory lives and how its confidence decays over time.",
    scope: "global+project",
    fields: [
      {
        key: "retention.ttlDays",
        domain: "retention",
        label: "TTL (days)",
        summary: "Age at which a memory becomes eligible for pruning review.",
        help:
          "Findings older than this are considered for cleanup during consolidation. "
          + "It does not delete anything by itself.",
        control: "number",
        range: { min: 7, max: 3650, step: 1 },
        default: DEFAULT_POLICY.ttlDays,
        scope: "global+project",
        impact: "Lower = memory turns over faster; higher = old findings linger longer.",
        risk: "safe",
      },
      {
        key: "retention.retentionDays",
        domain: "retention",
        label: "Retention (days)",
        summary: "Hard age cutoff — findings past this are pruned.",
        help:
          "The maximum age a finding can reach before `phren maintain prune` removes it. "
          + "Shrinking this can permanently drop old memory.",
        control: "number",
        range: { min: 30, max: 3650, step: 1 },
        default: DEFAULT_POLICY.retentionDays,
        scope: "global+project",
        impact: "Lowering this deletes findings older than the new cutoff on the next prune.",
        risk: "caution",
      },
      {
        key: "retention.autoAcceptThreshold",
        domain: "retention",
        label: "Auto-accept threshold",
        summary: "Confidence score above which a finding skips the review queue.",
        help:
          "Findings scoring at or above this go straight in; lower-scoring ones land in the "
          + "review queue for you to approve.",
        control: "number",
        range: { min: 0, max: 1, step: 0.05 },
        default: DEFAULT_POLICY.autoAcceptThreshold,
        scope: "global+project",
        impact: "Higher = more findings routed to manual review; lower = more auto-accepted.",
        risk: "safe",
      },
      {
        key: "retention.minInjectConfidence",
        domain: "retention",
        label: "Min inject confidence",
        summary: "Lowest confidence a finding may have to be injected into context.",
        help:
          "Findings scoring below this are kept on disk but not surfaced into the agent's "
          + "context automatically.",
        control: "number",
        range: { min: 0, max: 1, step: 0.05 },
        default: DEFAULT_POLICY.minInjectConfidence,
        scope: "global+project",
        impact: "Higher = only strong memories get injected; lower = weaker ones surface too.",
        risk: "safe",
      },
      {
        key: "retention.decay.d30",
        domain: "retention",
        label: "Decay @ 30 days",
        summary: "Confidence multiplier applied to a finding 30 days old.",
        help: "Part of the decay curve — how much a 30-day-old finding's confidence is scaled.",
        control: "number",
        range: { min: 0, max: 1, step: 0.05 },
        default: DEFAULT_POLICY.decay.d30,
        scope: "global+project",
        impact: "Lower values make recent memory fade faster.",
        risk: "safe",
      },
      {
        key: "retention.decay.d60",
        domain: "retention",
        label: "Decay @ 60 days",
        summary: "Confidence multiplier applied to a finding 60 days old.",
        help: "Part of the decay curve — how much a 60-day-old finding's confidence is scaled.",
        control: "number",
        range: { min: 0, max: 1, step: 0.05 },
        default: DEFAULT_POLICY.decay.d60,
        scope: "global+project",
        impact: "Lower values make mid-age memory fade faster.",
        risk: "safe",
      },
      {
        key: "retention.decay.d90",
        domain: "retention",
        label: "Decay @ 90 days",
        summary: "Confidence multiplier applied to a finding 90 days old.",
        help: "Part of the decay curve — how much a 90-day-old finding's confidence is scaled.",
        control: "number",
        range: { min: 0, max: 1, step: 0.05 },
        default: DEFAULT_POLICY.decay.d90,
        scope: "global+project",
        impact: "Lower values make older memory fade faster.",
        risk: "safe",
      },
      {
        key: "retention.decay.d120",
        domain: "retention",
        label: "Decay @ 120 days",
        summary: "Confidence multiplier applied to a finding 120 days old.",
        help: "Part of the decay curve — how much a 120-day-old finding's confidence is scaled.",
        control: "number",
        range: { min: 0, max: 1, step: 0.05 },
        default: DEFAULT_POLICY.decay.d120,
        scope: "global+project",
        impact: "Lower values make stale memory fade faster.",
        risk: "safe",
      },
    ],
  },
  {
    id: "workflow",
    label: "Workflow",
    icon: "settings-gear",
    summary: "Review gating and which memory sections are treated as risky.",
    scope: "global+project",
    fields: [
      {
        key: "workflow.lowConfidenceThreshold",
        domain: "workflow",
        label: "Low-confidence threshold",
        summary: "Score below which a finding is flagged as low-confidence.",
        help:
          "Findings scoring under this are treated as low-confidence and may be routed to the "
          + "review queue rather than accepted silently.",
        control: "number",
        range: { min: 0, max: 1, step: 0.05 },
        default: DEFAULT_WORKFLOW_POLICY.lowConfidenceThreshold,
        scope: "global+project",
        impact: "Higher = more findings flagged for review; lower = fewer flagged.",
        risk: "safe",
      },
      {
        key: "workflow.riskySections",
        domain: "workflow",
        label: "Risky sections",
        summary: "Review-queue sections that require explicit attention.",
        help:
          "Findings landing in these sections are surfaced for review instead of being "
          + "treated as settled. Choose any of Review, Stale, Conflicts.",
        control: "string-list",
        options: [
          { value: "Review", label: "Review", blurb: "Items explicitly queued for your review." },
          { value: "Stale", label: "Stale", blurb: "Findings that have aged past their TTL." },
          { value: "Conflicts", label: "Conflicts", blurb: "Findings that contradict another finding." },
        ],
        default: DEFAULT_WORKFLOW_POLICY.riskySections,
        scope: "global+project",
        impact: "More sections = more findings held back for explicit attention.",
        risk: "safe",
      },
    ],
  },
  {
    id: "index",
    label: "Index",
    icon: "search",
    summary: "Which files the search indexer reads.",
    scope: "global-only",
    fields: [
      {
        key: "index.includeGlobs",
        domain: "index",
        label: "Include globs",
        summary: "Glob patterns the indexer reads.",
        help:
          "Files matching any of these globs are indexed for search. Removing a pattern hides "
          + "those files from search until the next reindex.",
        control: "string-list",
        default: DEFAULT_INDEX_POLICY.includeGlobs,
        scope: "global-only",
        impact: "Narrowing this shrinks what search and context injection can find.",
        risk: "caution",
      },
      {
        key: "index.excludeGlobs",
        domain: "index",
        label: "Exclude globs",
        summary: "Glob patterns the indexer skips.",
        help:
          "Files matching any of these globs are never indexed, even if they match an include "
          + "pattern. Excludes win over includes.",
        control: "string-list",
        default: DEFAULT_INDEX_POLICY.excludeGlobs,
        scope: "global-only",
        impact: "Adding a pattern removes those files from search on the next reindex.",
        risk: "caution",
      },
      {
        key: "index.includeHidden",
        domain: "index",
        label: "Index hidden files",
        summary: "Whether dotfiles and dot-directories are indexed.",
        help: "When on, files and folders beginning with `.` are eligible for indexing.",
        control: "boolean",
        default: DEFAULT_INDEX_POLICY.includeHidden,
        scope: "global-only",
        impact: "Turning this on can pull in `.config` and similar files.",
        risk: "caution",
      },
    ],
  },
  {
    id: "topic",
    label: "Topics",
    icon: "symbol-namespace",
    summary: "Per-project topic classification for routing findings.",
    scope: "project-only",
    fields: [
      {
        key: "topic.domain",
        domain: "topic",
        label: "Project domain",
        summary: "The high-level domain this project belongs to.",
        help:
          "A coarse classification (e.g. backend, frontend, data) used to tune how findings "
          + "are organised for this project.",
        control: "string-list",
        default: null,
        scope: "project-only",
        impact: "Affects how new findings are routed into topic files.",
        risk: "safe",
      },
      {
        key: "topic.topics",
        domain: "topic",
        label: "Topics",
        summary: "Named topics findings are bucketed into for this project.",
        help:
          "Each topic has a slug, a label, an optional description, and keywords used to "
          + "match findings to it.",
        control: "object",
        default: [],
        scope: "project-only",
        impact: "Editing topics changes how this project's findings are grouped.",
        risk: "safe",
      },
    ],
  },
  {
    id: "access",
    label: "Access control",
    icon: "shield",
    summary: "Role-based permissions over who can read and write memory.",
    scope: "global+project",
    fields: [
      {
        key: "access.admins",
        domain: "access",
        label: "Admins",
        summary: "Actors allowed every action, including config changes.",
        help:
          "Actor names (matched against PHREN_ACTOR) with full permissions. "
          + "When all three role lists are empty, phren runs in open mode.",
        control: "string-list",
        default: [],
        scope: "global+project",
        impact: "Admins can change config and manage findings, tasks, and access itself.",
        risk: "caution",
      },
      {
        key: "access.contributors",
        domain: "access",
        label: "Contributors",
        summary: "Actors allowed to add and edit findings and tasks.",
        help: "Actor names with read-write access to findings and tasks but not config.",
        control: "string-list",
        default: [],
        scope: "global+project",
        impact: "Contributors can write memory but cannot change configuration.",
        risk: "caution",
      },
      {
        key: "access.readers",
        domain: "access",
        label: "Readers",
        summary: "Actors allowed read-only access.",
        help: "Actor names that may search and read but never mutate memory.",
        control: "string-list",
        default: [],
        scope: "global+project",
        impact: "Readers can search and view but cannot add or edit anything.",
        risk: "caution",
      },
    ],
  },
  {
    id: "dreaming",
    label: "Dreaming",
    icon: "sparkle",
    summary: "An offline pass that reorganizes a project's memory between sessions. Off by default.",
    scope: "global+project",
    fields: [
      {
        key: "dreaming.enabled",
        domain: "dreaming",
        label: "Dreaming",
        summary: "Whether the Hook runs dream passes on its own.",
        help:
          "A dream reads recent transcripts, the project's findings, truths and pages, and the repo's git log, "
          + "then corrects, merges and reorganizes memory. `phren dream run --force` still works when this is off.",
        control: "boolean",
        default: DEFAULT_DREAMING_CONFIG.enabled,
        scope: "global+project",
        impact: "On = the Hook spends helper-model usage on a scheduled pass for each enabled project.",
        risk: "caution",
      },
      {
        key: "dreaming.mode",
        domain: "dreaming",
        label: "Mode",
        summary: "Whether a dream proposes its changes or applies them.",
        help:
          "Propose puts one review-queue item per change, with its evidence, for you to accept. "
          + "Apply makes the changes through the normal finding, truth and topic APIs and logs them in dreams/journal.md.",
        control: "enum",
        options: [
          { value: "propose", label: "Propose", blurb: "Every change waits in the review queue for you.", recommended: true },
          { value: "apply", label: "Apply", blurb: "Changes are made directly and recorded in the dream journal." },
        ],
        default: DEFAULT_DREAMING_CONFIG.mode,
        scope: "global+project",
        impact: "Apply edits, supersedes and retracts findings without asking; every change stays in history.",
        risk: "caution",
      },
      {
        key: "dreaming.cadence",
        domain: "dreaming",
        label: "Cadence",
        summary: "When the Hook starts a dream on its own.",
        help:
          "Nightly runs once a day inside the window; weekly once a week inside the window; idle after the project "
          + "has had no live agent session for the idle time; manual only when you run `phren dream run`.",
        control: "enum",
        options: [
          { value: "nightly", label: "Nightly", blurb: "Once a day, inside the window.", recommended: true },
          { value: "idle", label: "Idle", blurb: "After the project has had no live agent session for a while." },
          { value: "weekly", label: "Weekly", blurb: "Once every seven days, inside the window." },
          { value: "manual", label: "Manual", blurb: "Only when you run it yourself." },
        ],
        default: DEFAULT_DREAMING_CONFIG.cadence,
        scope: "global+project",
        impact: "More frequent dreams use more helper usage and churn memory more often.",
        risk: "safe",
      },
      {
        key: "dreaming.window",
        domain: "dreaming",
        label: "Window",
        summary: "Local time range nightly and weekly dreams may start in (HH:MM-HH:MM).",
        help: "A range like 02:00-05:00; it may wrap midnight (23:00-04:00). Idle and manual dreams ignore it.",
        control: "string",
        default: DEFAULT_DREAMING_CONFIG.window,
        scope: "global+project",
        impact: "Pick hours when you are not working, so a dream never competes with a live session.",
        risk: "safe",
      },
      {
        key: "dreaming.idleMinutes",
        domain: "dreaming",
        label: "Idle minutes",
        summary: "For the idle cadence: minutes without a live agent session before a dream starts.",
        help: "The Hook checks every ten minutes, so a dream starts up to ten minutes after this much quiet.",
        control: "number",
        range: { ...DREAMING_RANGES.idleMinutes },
        default: DEFAULT_DREAMING_CONFIG.idleMinutes,
        scope: "global+project",
        impact: "Lower = dreams follow work sooner; higher = only after longer breaks.",
        risk: "safe",
      },
      {
        key: "dreaming.lookbackHours",
        domain: "dreaming",
        label: "Lookback (hours)",
        summary: "How far back a dream reads transcripts when it has no earlier run to start from.",
        help: "After the first dream, each one reads from the previous run's end; this caps the window otherwise.",
        control: "number",
        range: { ...DREAMING_RANGES.lookbackHours },
        default: DEFAULT_DREAMING_CONFIG.lookbackHours,
        scope: "global+project",
        impact: "Longer = more transcript evidence per dream, and a larger prompt.",
        risk: "safe",
      },
      {
        key: "dreaming.maxChanges",
        domain: "dreaming",
        label: "Max changes",
        summary: "The most changes one dream may make or propose.",
        help: "Changes past this cap are dropped and recorded in the dream's report.",
        control: "number",
        range: { ...DREAMING_RANGES.maxChanges },
        default: DEFAULT_DREAMING_CONFIG.maxChanges,
        scope: "global+project",
        impact: "Higher lets one dream reorganize more, and gives you more to review.",
        risk: "safe",
      },
      {
        key: "dreaming.injectBudgetKB",
        domain: "dreaming",
        label: "Inject budget (KB)",
        summary: "The cap on truths plus always-injected context; a dream demotes to stay under it.",
        help:
          "Whatever Phren injects at every session start spreads its errors to every session, so it stays small. "
          + "A dream will not promote a truth past this budget without demoting another.",
        control: "number",
        range: { ...DREAMING_RANGES.injectBudgetKB },
        default: DEFAULT_DREAMING_CONFIG.injectBudgetKB,
        scope: "global+project",
        impact: "Lower = a leaner session start; higher = more pinned context every session.",
        risk: "safe",
      },
      {
        key: "dreaming.phases",
        domain: "dreaming",
        label: "Phases",
        summary: "What a dream works on.",
        help: "Any of capture, correct, organize, prune. Unknown values are ignored.",
        control: "string-list",
        options: [
          { value: "capture", label: "Capture", blurb: "Save decisions and lessons the transcripts show but memory lacks." },
          { value: "correct", label: "Correct", blurb: "Fix or retract notes that transcripts, code or git contradict." },
          { value: "organize", label: "Organize", blurb: "Merge duplicates, move findings to topics, write subject pages." },
          { value: "prune", label: "Prune", blurb: "Demote and retire what no longer earns its place." },
        ],
        default: [...DEFAULT_DREAMING_CONFIG.phases],
        scope: "global+project",
        impact: "Fewer phases = a narrower, cheaper pass.",
        risk: "safe",
      },
      {
        key: "dreaming.model",
        domain: "dreaming",
        label: "Model",
        summary: "The model a dream runs on; empty uses the project's helper model.",
        help: "Runs under the project's helper account (phren.project.yaml helper: { account, model }).",
        control: "string",
        default: DEFAULT_DREAMING_CONFIG.model,
        scope: "global+project",
        impact: "A stronger model gives better judgment at a higher cost per dream.",
        risk: "safe",
      },
    ],
  },
];

// ── Lookups ───────────────────────────────────────────────────────────────────

const DOMAIN_BY_ID = new Map<ConfigDomainId, ConfigDomainDescriptor>(
  CONFIG_DOMAINS.map((d) => [d.id, d]),
);

const FIELD_BY_KEY = new Map<string, ConfigFieldDescriptor>(
  CONFIG_DOMAINS.flatMap((d) => d.fields.map((f) => [f.key, f] as const)),
);

/** Look up a domain descriptor by id. */
export function getConfigDomain(id: ConfigDomainId): ConfigDomainDescriptor | undefined {
  return DOMAIN_BY_ID.get(id);
}

/** Look up a field descriptor by its dotted key. */
export function getConfigField(key: string): ConfigFieldDescriptor | undefined {
  return FIELD_BY_KEY.get(key);
}

/** Every field across every domain, in domain order. */
export function allConfigFields(): ConfigFieldDescriptor[] {
  return CONFIG_DOMAINS.flatMap((d) => d.fields);
}

/**
 * Aliases mapping the historical hyphenated `phren config` subcommands to the
 * canonical domain ids. Help text and routing are generated from this so the
 * CLI surface can never drift from the schema.
 */
export const CONFIG_DOMAIN_ALIASES: Record<string, ConfigDomainId> = {
  proactivity: "proactivity",
  "task-mode": "taskMode",
  taskmode: "taskMode",
  "finding-sensitivity": "findingSensitivity",
  findingsensitivity: "findingSensitivity",
  policy: "retention",
  retention: "retention",
  workflow: "workflow",
  index: "index",
  topic: "topic",
  topics: "topic",
  access: "access",
  dreaming: "dreaming",
  dream: "dreaming",
};

/** Resolve a user-supplied domain/subcommand token to a canonical domain id. */
export function resolveConfigDomainAlias(token: string): ConfigDomainId | undefined {
  return CONFIG_DOMAIN_ALIASES[token.trim().toLowerCase()];
}
