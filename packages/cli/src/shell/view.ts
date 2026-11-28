
/**
 * View rendering functions for the phren interactive shell.
 * Extracted from shell.ts to keep the orchestrator under 300 lines.
 */

import { projectMemoryCounts } from "../content/summarize.js";
import * as fs from "fs";
import {
  listProjectCards,
  readFindings,
  readReviewQueue,
  readRuntimeHealth,
  ShellState,
} from "../data/access.js";
import {
  style,
  badge,
  separator,
  stripAnsi,
  truncateLine,
  displayWidth,
  renderWidth,
  wrapSegments,
  lineViewport,
  shellHelpText,
  gradient,
} from "./render.js";
import {
  formatSelectableLine,
  viewportWithStatus,
} from "./view-list.js";
import {
  SUB_VIEWS,
  enabledSubViews,
  TAB_ICONS,
  type DoctorResultLike,
} from "./types.js";
import {
  queueByFilter,
} from "./palette.js";
import {
  listMachines,
  listProfiles,
} from "../data/access.js";
import { readInstallPreferences } from "../init/preferences.js";
import { PROJECT_HOOK_EVENTS, isProjectHookEnabled, readProjectConfig } from "../project-config.js";
import { getScopedSkills } from "../skill/registry.js";
import { resolveProjectStorePath } from "../cli/namespaces-utils.js";
import type { GraphController } from "./graph/controller.js";
import { renderGraphView, graphSummary } from "./graph/graph-view.js";

/** Shared rendering state passed from the orchestrator */
export interface ViewContext {
  phrenPath: string;
  profile: string;
  state: ShellState;
  currentCursor: () => number;
  currentScroll: () => number;
  setScroll: (n: number) => void;
  /** The knowledge-graph view's controller (created on first use). Absent in hosts that only render menus. */
  graph?: () => GraphController;
}

// ── Tab bar ────────────────────────────────────────────────────────────────

/**
 * The whole top of the frame in as few rows as possible: brand, current view,
 * project and filter on one line, then a rule. On a 24-row terminal the old
 * three-row header cost more than a tenth of the screen.
 */
function renderTopBar(state: ShellState, summary = "", views: readonly typeof SUB_VIEWS[number][] = SUB_VIEWS): string {
  const cols = renderWidth();
  const brand = gradient("◆ phren");
  const dot = style.dim("·");
  const project = state.project ? `${dot} ${style.cyan(state.project)}` : "";
  const filter = state.filter ? `${dot} ${style.yellow("/" + state.filter)}` : "";
  const isSub = (SUB_VIEWS as readonly string[]).includes(state.view);

  if (!isSub) {
    const label = style.boldMagenta(`${TAB_ICONS[state.view] ?? "◆"} ${state.view}`);
    const line = ["  " + brand, label, project, filter, summary ? `${dot} ${summary}` : ""].filter(Boolean).join("  ");
    return `${truncateLine(line, cols)}\n${separator(cols)}`;
  }

  // Sub-views carry a tab strip. Try full labels, then icons for the inactive
  // tabs, before giving up and taking a second row.
  const head = `  ${brand}${project ? `  ${project}` : ""}${filter ? `  ${filter}` : ""}`;
  const full = views.map((v) => (v === state.view ? style.boldMagenta(`${TAB_ICONS[v]} ${v}`) : style.dim(`${TAB_ICONS[v]} ${v}`)));
  const terse = views.map((v) => (v === state.view ? style.boldMagenta(`${TAB_ICONS[v]} ${v}`) : style.dim(TAB_ICONS[v] ?? "")));
  for (const tabs of [full, terse]) {
    const merged = `${head}  ${style.dim("│")} ${tabs.join(style.dim(" │ "))}`;
    if (displayWidth(merged) <= cols) return `${merged}\n${separator(cols)}`;
  }
  const tabLine = wrapSegments(full, cols, { indent: "  ", maxLines: 2, separator: style.dim("│") });
  return `${head}\n${tabLine}\n${separator(cols)}`;
}

// ── Bottom bar ─────────────────────────────────────────────────────────────

function renderBottomBar(state: ShellState, navMode: "navigate" | "input", inputCtx: string, inputBuf: string): string {
  const cols = renderWidth();
  const sep = separator(cols);
  const dot = style.dim("  ·  ");
  const k = (s: string) => style.boldCyan(s);
  const d = (s: string) => style.dim(s);

  if (navMode === "input") {
    const labels: Record<string, string> = {
      filter: "filter",
      command: "cmd",
      "learn-add": "add finding",
      "skill-add": "new skill name",
      "graph-search": "search graph",
    };
    const label = labels[inputCtx] || inputCtx;
    return `${sep}\n  ${style.boldCyan(label + " ›")} ${inputBuf}${style.cyan("█")}`;
  }

  // Only what you reach for constantly. Everything else is one `?` away, so
  // the bar never costs more than a single row.
  const essentials: Record<string, string[]> = {
    Projects: [`${k("↑↓")} ${d("move")}`, `${k("↵")} ${d("open")}`, `${k("e")} ${d("edit AGENTS.md")}`],
    Findings: [`${k("↑↓")} ${d("move")}`, `${k("a")} ${d("add")}`],
    "Review Queue": [`${k("↑↓")} ${d("move")}`, `${k("↵")} ${d("inspect")}`],
    Skills: [`${k("↑↓")} ${d("move")}`, `${k("e")} ${d("edit")}`, `${k("t")} ${d("toggle")}`],
    Hooks: [`${k("↑↓")} ${d("move")}`, `${k("a")} ${d("enable")}`],
    Health: [`${k("↑↓")} ${d("scroll")}`],
    Graph: [`${k("↑↓←→")} ${d("walk")}`, `${k("↵")} ${d("select")}`, `${k("␣")} ${d("read")}`, `${k("v")} ${d("orbit")}`, `${k("w")} ${d("watch")}`, `${k("a")} ${d("agents")}`],
  };
  const search = state.view === "Graph" ? `${k("/")} ${d("search")}` : `${k("/")} ${d("filter")}`;
  // `? keys` and `q quit` are the two you cannot afford to lose, so a narrow
  // terminal drops view hints off the end instead of truncating those away.
  const always = [`${k("?")} ${d("keys")}`, `${k("q")} ${d("quit")}`];
  const optional = [...(essentials[state.view] ?? []), search];
  let line = "";
  for (let take = optional.length; take >= 0; take--) {
    line = wrapSegments([...optional.slice(0, take), ...always], cols, { indent: "  ", maxLines: 1, separator: dot });
    if (!stripAnsi(line).trimEnd().endsWith("…")) break;
  }
  return `${sep}\n${line}`;
}

// ── Content height ─────────────────────────────────────────────────────────

function countRenderedLines(block: string): number {
  return block.split("\n").length;
}

function contentHeight(topBar: string, bottomBar: string, hasMessage: boolean): number {
  const rows = process.stdout.rows || 24;
  const reserved = countRenderedLines(topBar) + countRenderedLines(bottomBar) + (hasMessage ? 1 : 0);
  return Math.max(4, rows - reserved);
}

// ── Projects view ──────────────────────────────────────────────────────────

interface ProjectDashboardEntry {
  name: string;
  summary: string;
  docs: string[];
  store?: string;
  findingCount: number;
  reviewCount: number;
}

function collectProjectDashboardEntries(ctx: ViewContext): ProjectDashboardEntry[] {
  const cards = listProjectCards(ctx.phrenPath, ctx.profile);
  return cards.map((card) => {
    if (card.name === "global") {
      return {
        ...card,
        findingCount: 0,
        reviewCount: 0,
      };
    }

    const storePath = resolveProjectStorePath(ctx.phrenPath, card.name);
    const findings = readFindings(storePath, card.name);
    const review = readReviewQueue(storePath, card.name);

    return {
      ...card,
      // Everything the project holds, archive included, as every graph shows it.
      findingCount: findings.ok ? projectMemoryCounts(storePath, card.name).findings : 0,
      reviewCount: review.ok ? review.data.length : 0,
    };
  });
}

function renderProjectsDashboard(ctx: ViewContext, entries: ProjectDashboardEntry[], height: number): string[] {
  const runtime = readRuntimeHealth(ctx.phrenPath);
  const scoped = entries.filter((entry) => entry.name !== "global");
  const totals = scoped.reduce((acc, entry) => {
    acc.findings += entry.findingCount;
    acc.review += entry.reviewCount;
    return acc;
  }, { findings: 0, review: 0 });

  const findingsPreview = scoped
    .filter((entry) => entry.findingCount > 0)
    .slice(0, 3)
    .map((entry) => `${style.bold(entry.name)} ${style.dim(`${entry.findingCount} findings`)}`);

  const lines = [
    `  ${badge(ctx.profile || "default", style.boldBlue)}  ${style.bold(String(scoped.length))} projects  ${style.dim("·")}  ${style.boldCyan(String(totals.findings))} findings  ${style.dim("·")}  ${style.boldMagenta(String(totals.review))} review`,
    ctx.state.project
      ? `  ${style.green("●")} active context ${style.boldCyan(ctx.state.project)}  ${style.dim("· ↵ opens selected project findings")}`
      : `  ${style.dim("No project selected yet")}  ${style.dim("· ↵ sets context and opens findings")}`,
    `  ${style.dim("Sync")} ${style.dim(runtime.lastSync?.lastPushStatus || runtime.lastAutoSave?.status || "unknown")}  ${style.dim("·")}  ${style.dim("unsynced")} ${style.bold(String(runtime.lastSync?.unsyncedCommits ?? 0))}  ${style.dim("·")}  ${style.dim("intro")} ${style.cyan(ctx.state.introMode || "once-per-version")}`,
  ];

  if (height >= 12) {
    lines.push("");
    lines.push(`  ${style.bold("Recent fragments")}  ${findingsPreview.length ? findingsPreview.join(style.dim("  ·  ")) : style.dim("Nothing yet.")}`);
  }

  lines.push("");
  lines.push(`  ${style.bold("Projects")}  ${style.dim("press ↵ to open a project, / to filter, :intro to tune startup")}`);
  return lines;
}

function renderProjectsView(ctx: ViewContext, cursor: number, height: number): string[] {
  const cols = renderWidth();
  const cards = collectProjectDashboardEntries(ctx);
  const filtered = ctx.state.filter
    ? cards.filter((c) =>
      `${c.name} ${c.summary} ${c.docs.join(" ")}`.toLowerCase().includes(ctx.state.filter!.toLowerCase()),
    )
    : cards;

  if (!filtered.length) {
    return [style.dim("  No projects in this profile.")];
  }

  const dashboardLines = renderProjectsDashboard(ctx, cards, height);
  const listHeight = Math.max(4, height - dashboardLines.length);

  const allLines: string[] = [];
  let cursorFirstLine = 0;
  let cursorLastLine = 0;

  for (let absIdx = 0; absIdx < filtered.length; absIdx++) {
    const card = filtered[absIdx];
    const isSelected = absIdx === cursor;
    if (isSelected) cursorFirstLine = allLines.length;
    const isActive = card.name === ctx.state.project;

    const cursorChar = isSelected ? style.cyan("▶") : " ";
    const bullet = isActive ? style.green("●") : style.dim("○");
    const nameStr = isActive ? style.boldGreen(card.name) : style.bold(card.name);
    const docsStr = style.dim(`[F${card.findingCount} · R${card.reviewCount}]`);
    const storeStr = card.store ? `  ${style.dim("·")} ${style.cyan(card.store)}` : "";

    let nameRow = `  ${cursorChar} ${bullet} ${nameStr}  ${docsStr}${storeStr}`;
    let summaryRow = `        ${style.dim(card.summary || "No summary yet.")}`;

    if (isSelected) {
      nameRow = formatSelectableLine(nameRow, cols, true);
      summaryRow = formatSelectableLine(summaryRow, cols, true);
    }

    allLines.push(nameRow);
    allLines.push(summaryRow);
    if (isSelected) cursorLastLine = allLines.length - 1;
  }

  const usableHeight = Math.max(1, listHeight - (allLines.length > listHeight ? 1 : 0));
  const vp = viewportWithStatus(
    allLines,
    cursorFirstLine,
    cursorLastLine,
    usableHeight,
    ctx.currentScroll(),
    cursor,
    filtered.length,
  );
  ctx.setScroll(vp.scrollStart);
  return [...dashboardLines, ...vp.lines];
}

// ── Findings view ──────────────────────────────────────────────────────────

function renderFindingsView(ctx: ViewContext, cursor: number, height: number): string[] {
  const cols = renderWidth();
  const project = ctx.state.project;
  if (!project) return [style.dim("  No project selected.")];

  const storePath = resolveProjectStorePath(ctx.phrenPath, project);
  const result = readFindings(storePath, project);
  if (!result.ok) return [result.error];

  const all = result.data;
  const filtered = ctx.state.filter
    ? all.filter((item) =>
      `${item.id} ${item.date} ${item.text}`.toLowerCase().includes(ctx.state.filter!.toLowerCase()),
    )
    : all;

  if (!filtered.length) {
    return [style.dim(`  Nothing here yet. Press ${style.boldCyan("a")} to tell phren something.`)];
  }

  const allLines: string[] = [];
  let cursorFirstLine = 0;
  let cursorLastLine = 0;

  for (let absIdx = 0; absIdx < filtered.length; absIdx++) {
    const item = filtered[absIdx];
    const isSelected = absIdx === cursor;

    if (isSelected) cursorFirstLine = allLines.length;

    const idStr = style.dim(item.id.padEnd(4));
    const dateStr = style.dim(`[${item.date}]`);

    let row = `  ${idStr}  ${dateStr}  ${item.text}`;
    row = formatSelectableLine(row, cols, isSelected);
    allLines.push(row);

    if (item.citation) {
      const cite = `              ${style.italic(style.blue("↗ " + item.citation))}`;
      allLines.push(formatSelectableLine(cite, cols, isSelected));
    }

    if (isSelected) cursorLastLine = allLines.length - 1;
  }

  const usableHeight = Math.max(1, height - (allLines.length > height ? 1 : 0));
  const vp = viewportWithStatus(
    allLines,
    cursorFirstLine,
    cursorLastLine,
    usableHeight,
    ctx.currentScroll(),
    cursor,
    filtered.length,
  );
  ctx.setScroll(vp.scrollStart);
  return vp.lines;
}

// ── Review Queue view ──────────────────────────────────────────────────────

function queueSectionBadge(section: string): string {
  switch (section.toLowerCase()) {
    case "review": return badge(section, style.yellow);
    case "stale": return badge(section, style.red);
    case "conflicts": return badge(section, style.magenta);
    default: return badge(section, style.dim);
  }
}

function renderMemoryQueueView(ctx: ViewContext, cursor: number, height: number): string[] {
  const cols = renderWidth();
  const project = ctx.state.project;
  if (!project) return [style.dim("  No project selected.")];

  const storePath = resolveProjectStorePath(ctx.phrenPath, project);
  const result = readReviewQueue(storePath, project);
  if (!result.ok) return [result.error];

  const filtered = ctx.state.filter
    ? queueByFilter(result.data, ctx.state.filter)
    : result.data;

  if (!filtered.length) {
    return [style.dim("  No queued memory items. Run :govern to scan for stale entries.")];
  }

  const allLines: string[] = [];
  let cursorFirstLine = 0;
  let cursorLastLine = 0;
  let currentSection = "";

  for (let absIdx = 0; absIdx < filtered.length; absIdx++) {
    const item = filtered[absIdx];
    const isSelected = absIdx === cursor;

    if (item.section !== currentSection) {
      currentSection = item.section;
      allLines.push(`  ${queueSectionBadge(currentSection)} ${style.bold(currentSection)}`);
    }

    if (isSelected) cursorFirstLine = allLines.length;

    const riskBadge = item.risky ? badge("risk", style.boldRed) : badge("ok", style.green);
    const confStr = item.confidence !== undefined
      ? ` ${style.dim("conf=")}${item.confidence >= 0.8 ? style.green(item.confidence.toFixed(2))
        : item.confidence >= 0.6 ? style.yellow(item.confidence.toFixed(2))
          : style.red(item.confidence.toFixed(2))}`
      : "";

    let metaRow = `    ${style.dim(item.id)}  ${riskBadge}  ${style.dim(`[${item.date}]`)}${confStr}`;
    let textRow = `      ${item.text}`;

    if (isSelected) {
      metaRow = formatSelectableLine(metaRow, cols, true);
      textRow = formatSelectableLine(textRow, cols, true);
    } else {
      metaRow = truncateLine(metaRow, cols);
      textRow = truncateLine(textRow, cols);
    }

    allLines.push(metaRow);
    allLines.push(textRow);

    if (isSelected) cursorLastLine = allLines.length - 1;
  }

  const usableHeight = Math.max(1, height - (allLines.length > height ? 1 : 0));
  const vp = viewportWithStatus(
    allLines,
    cursorFirstLine,
    cursorLastLine,
    usableHeight,
    ctx.currentScroll(),
    cursor,
    filtered.length,
  );
  ctx.setScroll(vp.scrollStart);
  return vp.lines;
}

// ── Skills view ────────────────────────────────────────────────────────────

export interface SkillEntry {
  name: string;
  path: string;
  enabled: boolean;
  /** "global" or "project" — the scope key enable/disable is recorded under. */
  scopeType?: string;
  /** The store this skill was read from, which may be a team store. */
  storePath?: string;
}

export function getProjectSkills(phrenPath: string, project: string): SkillEntry[] {
  const storePath = resolveProjectStorePath(phrenPath, project);
  return getScopedSkills(storePath, "", project).map((skill) => ({
    name: skill.name,
    path: skill.path,
    enabled: skill.enabled,
    // Carried so actions do not have to guess: a global skill toggled with the
    // project as its scope writes a key nothing reads, and a path recovered by
    // splitting a display string breaks on any path containing the separator.
    scopeType: skill.scopeType,
    storePath,
  }));
}

/** Max lines of skill content to show inline when selected. */
const SKILL_PREVIEW_LINES = 20;

function readSkillBody(skillPath: string): string[] {
  try {
    const raw = fs.readFileSync(skillPath, "utf8");
    // Strip YAML frontmatter (--- ... ---)
    const stripped = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const fmMatch = stripped.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
    const body = fmMatch ? fmMatch[1] : stripped;
    // Strip leading title (# ...) and blank lines
    const lines = body.split("\n");
    let start = 0;
    while (start < lines.length && (lines[start].trim() === "" || lines[start].startsWith("# "))) start++;
    return lines.slice(start, start + SKILL_PREVIEW_LINES);
  } catch {
    return ["(could not read skill file)"];
  }
}

function renderSkillsView(ctx: ViewContext, cursor: number, height: number): string[] {
  const cols = renderWidth();
  const project = ctx.state.project;
  if (!project) return [style.dim("  No project selected.")];

  const skills = getProjectSkills(ctx.phrenPath, project);
  const filtered = ctx.state.filter
    ? skills.filter((s) => s.name.toLowerCase().includes(ctx.state.filter!.toLowerCase()))
    : skills;

  if (!filtered.length) {
    return [style.dim(`  No skills for ${project}. Use "phren skills add ${project} <path>" to add one.`)];
  }

  const allLines: string[] = [];
  let cursorFirstLine = 0;
  let cursorLastLine = 0;

  for (let i = 0; i < filtered.length; i++) {
    const s = filtered[i];
    const isSelected = i === cursor;
    if (isSelected) cursorFirstLine = allLines.length;

    const isSymlink = (() => { try { return fs.lstatSync(s.path).isSymbolicLink(); } catch { return false; } })();
    const linkTag = isSymlink ? style.dim(" →") : "";
    const status = s.enabled ? style.boldGreen("enabled ") : style.dim("disabled");
    let row = `  ${style.dim((i + 1).toString().padEnd(3))} ${status} ${style.bold(s.name)}${linkTag}`;
    row = formatSelectableLine(row, cols, isSelected);
    allLines.push(row);

    // Show inline content preview for the selected skill
    if (isSelected) {
      const bodyLines = readSkillBody(s.path);
      if (bodyLines.length > 0) {
        allLines.push("");
        for (const line of bodyLines) {
          allLines.push(truncateLine(`      ${style.dim(line)}`, cols));
        }
        allLines.push("");
      }
    }

    if (isSelected) cursorLastLine = allLines.length - 1;
  }

  const usableHeight = Math.max(1, height - (allLines.length > height ? 1 : 0));
  const vp = viewportWithStatus(
    allLines,
    cursorFirstLine,
    cursorLastLine,
    usableHeight,
    ctx.currentScroll(),
    cursor,
    filtered.length,
  );
  ctx.setScroll(vp.scrollStart);
  return vp.lines;
}

// ── Hooks view ─────────────────────────────────────────────────────────────

export interface HookEntry {
  event: string;
  description: string;
  enabled: boolean;
}

const LIFECYCLE_HOOKS: Array<{ event: string; description: string }> = [
  { event: "UserPromptSubmit", description: "inject context before each prompt" },
  { event: "Stop",             description: "phren saves findings after each response" },
  { event: "SessionStart",     description: "git pull at session start" },
];

export function getHookEntries(phrenPath: string, project?: string | null): HookEntry[] {
  const prefs = readInstallPreferences(phrenPath);
  const hooksEnabled = prefs.hooksEnabled !== false;
  const storePath = project ? resolveProjectStorePath(phrenPath, project) : phrenPath;
  const projectConfig = project ? readProjectConfig(storePath, project) : undefined;
  return LIFECYCLE_HOOKS.map((h) => ({
    ...h,
    enabled: hooksEnabled && isProjectHookEnabled(storePath, project, h.event as typeof PROJECT_HOOK_EVENTS[number], projectConfig),
  }));
}

function renderHooksView(ctx: ViewContext, cursor: number, height: number): string[] {
  const cols = renderWidth();
  const entries = getHookEntries(ctx.phrenPath, ctx.state.project);
  const allEnabled = entries.every((e) => e.enabled);
  const allLines: string[] = [];
  let cursorFirstLine = 0;
  let cursorLastLine = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const isSelected = i === cursor;
    if (isSelected) cursorFirstLine = allLines.length;

    const statusBadge = e.enabled ? style.boldGreen("active  ") : style.dim("inactive");
    let nameRow = `  ${style.dim((i + 1).toString().padEnd(3))} ${statusBadge}  ${style.bold(e.event)}`;
    let descRow = `                    ${style.dim(e.description)}`;

    if (isSelected) {
      nameRow = formatSelectableLine(nameRow, cols, true);
      descRow = formatSelectableLine(descRow, cols, true);
    } else {
      nameRow = truncateLine(nameRow, cols);
      descRow = truncateLine(descRow, cols);
    }
    allLines.push(nameRow);
    allLines.push(descRow);

    if (isSelected) cursorLastLine = allLines.length - 1;
  }

  allLines.push("");
  allLines.push(style.dim(`  hooks: ${allEnabled ? style.boldGreen("ON") : style.boldRed("OFF")}  ·  ${style.dim("a = enable all  ·  d = disable all")}`));

  const usableHeight = Math.max(1, height - (allLines.length > height ? 1 : 0));
  const vp = viewportWithStatus(
    allLines,
    cursorFirstLine,
    cursorLastLine,
    usableHeight,
    ctx.currentScroll(),
    cursor,
    entries.length,
  );
  ctx.setScroll(vp.scrollStart);
  return vp.lines;
}

export { writeInstallPreferences } from "../init/preferences.js";

// ── Machines/Profiles view ─────────────────────────────────────────────────

function renderMachinesView(phrenPath: string): string[] {
  const machines = listMachines(phrenPath);
  const profiles = listProfiles(phrenPath);
  const lines: string[] = [];

  lines.push(style.bold("  Machines"));
  if (!machines.ok) {
    lines.push(`    ${style.dim(machines.error)}`);
  } else {
    const entries = Object.entries(machines.data);
    if (!entries.length) lines.push(`    ${style.dim("(none)")}`);
    for (const [machine, prof] of entries) {
      lines.push(`    ${style.bold(machine)} ${style.dim("→")} ${style.cyan(prof as string)}`);
    }
  }

  lines.push("", style.bold("  Profiles"));
  if (!profiles.ok) {
    lines.push(`    ${style.dim(profiles.error)}`);
  } else {
    if (!profiles.data.length) lines.push(`    ${style.dim("(none)")}`);
    for (const prof of profiles.data) {
      lines.push(`    ${style.cyan(prof.name)}: ${prof.projects.join(", ") || style.dim("(no projects)")}`);
    }
  }

  lines.push(
    "",
    `  ${style.dim(":machine map <hostname> <profile>")}`,
    `  ${style.dim(":profile add-project|remove-project <profile> <project>")}`,
  );

  return lines;
}

// ── Health view ────────────────────────────────────────────────────────────

function renderHealthView(
  phrenPath: string,
  doctor: DoctorResultLike,
  cursor: number,
  height: number,
  currentScroll: number,
  setScroll: (n: number) => void,
): { lines: string[]; lineCount: number } {
  const runtime = readRuntimeHealth(phrenPath);
  const allLines: string[] = [];

  const statusIcon = doctor.ok ? style.green("✓") : style.red("✗");
  const statusLabel = doctor.ok ? style.boldGreen("healthy") : style.boldRed("issues found");
  allLines.push(`  ${statusIcon}  ${style.bold("phren")} ${statusLabel}`);
  if (doctor.machine) allLines.push(`     ${style.dim("machine:")} ${style.bold(doctor.machine)}`);
  if (doctor.profile) allLines.push(`     ${style.dim("profile:")} ${style.cyan(doctor.profile)}`);

  allLines.push("", `  ${style.bold("Checks")}`);
  for (const check of doctor.checks) {
    const icon = check.ok ? style.green("✓") : style.red("✗");
    const status = check.ok ? style.dim("ok") : style.boldRed("fail");
    allLines.push(`    ${icon} ${status}  ${check.name}: ${check.detail}`);
  }

  allLines.push("", `  ${style.bold("Runtime")}`);
  allLines.push(`    ${style.dim("last hook:   ")} ${style.dim(runtime.lastPromptAt || "n/a")}`);
  allLines.push(`    ${style.dim("last auto-save:  ")} ${style.dim(runtime.lastAutoSave?.at || "n/a")}  ${style.dim(runtime.lastAutoSave?.status || "")}`);
  allLines.push(`    ${style.dim("last governance: ")} ${style.dim(runtime.lastGovernance?.at || "n/a")}  ${style.dim(runtime.lastGovernance?.status || "")}`);
  allLines.push(`    ${style.dim("last pull:      ")} ${style.dim(runtime.lastSync?.lastPullAt || "n/a")}  ${style.dim(runtime.lastSync?.lastPullStatus || "")}`);
  allLines.push(`    ${style.dim("last push:      ")} ${style.dim(runtime.lastSync?.lastPushAt || "n/a")}  ${style.dim(runtime.lastSync?.lastPushStatus || "")}`);
  allLines.push(`    ${style.dim("unsynced:       ")} ${style.bold(String(runtime.lastSync?.unsyncedCommits ?? 0))} ${style.dim("commit(s)")}`);

  if (!doctor.ok) {
    allLines.push("", `  ${style.boldYellow("→")} ${style.bold(":run fix")} ${style.dim("to auto-heal")}  ${style.dim(":relink  :rerun hooks  :update")}`);
  } else {
    allLines.push("", `  ${style.dim(":run fix  :relink  :rerun hooks  :update")}`);
  }

  const lineCount = allLines.length;
  if (allLines.length <= height) return { lines: allLines, lineCount };

  const cols = renderWidth();
  const clampedCursor = Math.max(0, Math.min(cursor, allLines.length - 1));
  allLines[clampedCursor] = formatSelectableLine(allLines[clampedCursor], cols, true);
  const vp = lineViewport(allLines, clampedCursor, clampedCursor, height - 1, currentScroll);
  setScroll(vp.scrollStart);
  const pct = allLines.length <= 1 ? 100 : Math.round((clampedCursor / (allLines.length - 1)) * 100);
  vp.lines.push(style.dim(`  ━━━${clampedCursor + 1}/${allLines.length}  ${pct}%`));
  return { lines: vp.lines, lineCount };
}

// ── Main render ────────────────────────────────────────────────────────────

export async function renderShell(
  ctx: ViewContext,
  navMode: "navigate" | "input",
  inputCtx: string,
  inputBuf: string,
  showHelp: boolean,
  helpScroll: number,
  message: string,
  doctorSnapshot: () => Promise<DoctorResultLike>,
  setHealthLineCount: (n: number) => void,
): Promise<string> {
  const graphSummaryLine = ctx.state.view === "Graph" && ctx.graph ? graphSummary(ctx.graph()) : "";
  const topBar = renderTopBar(ctx.state, graphSummaryLine, enabledSubViews(ctx.phrenPath, ctx.profile));
  const bottomBar = renderBottomBar(ctx.state, navMode, inputCtx, inputBuf);
  const cursor = ctx.currentCursor();
  // An empty message line used to hold a row open on every frame.
  const hasMessage = Boolean(stripAnsi(message).trim());
  const height = contentHeight(topBar, bottomBar, hasMessage);

  let contentLines: string[];
  if (showHelp) {
    // The help is longer than a small terminal, and used to be clipped in
    // silence — on 24 rows more than half of it simply was not there.
    const all = shellHelpText().split("\n");
    if (all.length <= height) {
      contentLines = all;
    } else {
      const maxScroll = all.length - (height - 1);
      const start = Math.max(0, Math.min(helpScroll, maxScroll));
      contentLines = all.slice(start, start + height - 1);
      const atEnd = start >= maxScroll;
      contentLines.push(style.dim(`  ━━━ ${start + 1}-${start + height - 1} of ${all.length}   ${atEnd ? "↑ back" : "↑↓ scroll"}`));
    }
  } else {
    switch (ctx.state.view) {
      case "Projects":
        contentLines = renderProjectsView(ctx, cursor, height);
        break;
      case "Findings":
        contentLines = renderFindingsView(ctx, cursor, height);
        break;
      case "Review Queue":
        contentLines = renderMemoryQueueView(ctx, cursor, height);
        break;
      case "Skills":
        contentLines = renderSkillsView(ctx, cursor, height);
        break;
      case "Hooks":
        contentLines = renderHooksView(ctx, cursor, height);
        break;
      case "Machines/Profiles":
        contentLines = renderMachinesView(ctx.phrenPath);
        break;
      case "Health": {
        const doctor = await doctorSnapshot();
        const result = renderHealthView(ctx.phrenPath, doctor, cursor, height, ctx.currentScroll(), ctx.setScroll);
        contentLines = result.lines;
        setHealthLineCount(result.lineCount);
        break;
      }
      case "Graph": {
        if (!ctx.graph) { contentLines = ["  The graph view needs the interactive shell — run `phren shell`."]; break; }
        const controller = ctx.graph();
        await controller.ensureData();
        const offer = controller.agentHint();
        if (offer) message = `  ${style.boldCyan("▲")} ${style.dim(`${offer} — press`)} ${style.boldCyan("a")} ${style.dim("to see them")}`;
        contentLines = renderGraphView(controller, renderWidth(), height);
        // Mouse reports are terminal coordinates; the canvas starts under the top bar.
        controller.canvasOrigin = { col: 0, row: topBar.split("\n").length };
        break;
      }
      default:
        contentLines = ["  Unknown view."];
    }
  }

  const displayed = contentLines.slice(0, height);
  while (displayed.length < height) displayed.push("");

  const cols = renderWidth();
  const parts = [topBar, ...displayed, ...(hasMessage ? [`  ${style.dimItalic(message.trimStart())}`] : []), bottomBar];
  return parts.map(line => {
    if (line.includes("\n")) {
      return line.split("\n").map(sub => truncateLine(sub, cols) + "\x1b[K").join("\n");
    }
    return truncateLine(line, cols) + "\x1b[K";
  }).join("\n");
}
