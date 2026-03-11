/**
 * View rendering functions for the cortex interactive shell.
 * Extracted from shell.ts to keep the orchestrator under 300 lines.
 */

import * as fs from "fs";
import * as path from "path";
import {
  canonicalTaskFilePath,
  listProjectCards,
  readBacklog,
  readFindings,
  readReviewQueue,
  readRuntimeHealth,
  resolveTaskFilePath,
  ShellState,
} from "./data-access.js";
import {
  style,
  badge,
  separator,
  stripAnsi,
  truncateLine,
  renderWidth,
  wrapSegments,
  lineViewport,
  shellHelpText,
  gradient,
} from "./shell-render.js";
import {
  formatSelectableLine,
  viewportWithStatus,
} from "./shell-view-list.js";
import {
  SUB_VIEWS,
  TAB_ICONS,
  type DoctorResultLike,
} from "./shell-types.js";
import {
  backlogsByFilter,
  queueByFilter,
} from "./shell-palette.js";
import {
  listMachines,
  listProfiles,
} from "./data-access.js";
import { readInstallPreferences } from "./init-preferences.js";
import { PROJECT_HOOK_EVENTS, isProjectHookEnabled, readProjectConfig } from "./project-config.js";
import { getScopedSkills } from "./skill-registry.js";

/** Shared rendering state passed from the orchestrator */
export interface ViewContext {
  cortexPath: string;
  profile: string;
  state: ShellState;
  currentCursor: () => number;
  currentScroll: () => number;
  setScroll: (n: number) => void;
}

// ── Tab bar ────────────────────────────────────────────────────────────────

function renderTabBar(state: ShellState): string {
  const cols = renderWidth();

  if (state.view === "Health") {
    const label = `${TAB_ICONS.Health} Health`;
    return `  ${style.boldMagenta(label)}\n${separator(cols)}`;
  }

  if (state.view === "Projects") {
    const label = `${TAB_ICONS.Projects} Projects`;
    const tabLine = ` ${style.boldMagenta(label)} `;
    return `${tabLine}\n${separator(cols)}`;
  }

  const projectTag = state.project
    ? `${style.cyan(state.project)} ${style.dim("›")}`
    : "";
  const tabs = SUB_VIEWS.map((v) => {
    const icon = TAB_ICONS[v] || "";
    const label = `${icon} ${v}`;
    return v === state.view
      ? ` ${style.boldMagenta(label)} `
      : ` ${style.dim(label)} `;
  });

  const segments = projectTag ? [projectTag, ...tabs] : tabs;
  const tabLine = wrapSegments(segments, cols, {
    indent: "  ",
    maxLines: 2,
    separator: style.dim("│"),
  });
  return `${tabLine}\n${separator(cols)}`;
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
      add: "add task",
      "learn-add": "add finding",
      "skill-add": "new skill name",
      "mq-edit": "edit Review Queue item",
    };
    const label = labels[inputCtx] || inputCtx;
    return `${sep}\n  ${style.boldCyan(label + " ›")} ${inputBuf}${style.cyan("█")}`;
  }

  const viewHints: Record<string, string[]> = {
    Projects: [`${k("↵")} ${d("open project")}`, `${k("i")} ${d("intro mode")}`],
    Tasks: [`${k("a")} ${d("add")}`, `${k("↵")} ${d("mark done")}`, `${k("d")} ${d("toggle active")}`],
    Findings: [`${k("a")} ${d("add")}`, `${k("d")} ${d("remove")}`],
    "Review Queue": [`${k("a")} ${d("keep")}`, `${k("d")} ${d("discard")}`, `${k("e")} ${d("edit")}`],
    Skills: [`${k("t")} ${d("toggle")}`, `${k("d")} ${d("remove")}`],
    Hooks: [`${k("a")} ${d("enable")}`, `${k("d")} ${d("disable")}`],
    Health: [`${k("↑↓")} ${d("scroll")}`, `${k("esc")} ${d("back")}`],
  };

  const extra = viewHints[state.view] ?? [];
  const isSubView = state.view !== "Projects" && state.view !== "Health";
  const nav = isSubView
    ? [`${k("←→")} ${d("tabs")}`, `${k("↑↓")} ${d("move")}`, `${k("esc")} ${d("back")}`]
    : state.view === "Health"
      ? []
      : [`${k("↑↓")} ${d("move")}`];
  const tail = [`${k("h")} ${d("health")}`, `${k("/")} ${d("filter")}`, `${k(":")} ${d("cmd")}`, `${k("?")} ${d("help")}`, `${k("q")} ${d("quit")}`];

  const hints = [...nav, ...extra, ...tail];
  return `${sep}\n${wrapSegments(hints, cols, {
    indent: "  ",
    maxLines: 3,
    separator: dot,
  })}`;
}

// ── Content height ─────────────────────────────────────────────────────────

function countRenderedLines(block: string): number {
  return block.split("\n").length;
}

function contentHeight(tabBar: string, bottomBar: string): number {
  const rows = process.stdout.rows || 24;
  const reserved = 1 + countRenderedLines(tabBar) + 1 + countRenderedLines(bottomBar);
  return Math.max(4, rows - reserved);
}

// ── Projects view ──────────────────────────────────────────────────────────

interface ProjectDashboardEntry {
  name: string;
  summary: string;
  docs: string[];
  activeCount: number;
  queueCount: number;
  findingCount: number;
  reviewCount: number;
}

function collectProjectDashboardEntries(ctx: ViewContext): ProjectDashboardEntry[] {
  const cards = listProjectCards(ctx.cortexPath, ctx.profile);
  return cards.map((card) => {
    if (card.name === "global") {
      return {
        ...card,
        activeCount: 0,
        queueCount: 0,
        findingCount: 0,
        reviewCount: 0,
      };
    }

    const backlog = readBacklog(ctx.cortexPath, card.name);
    const findings = readFindings(ctx.cortexPath, card.name);
    const review = readReviewQueue(ctx.cortexPath, card.name);

    return {
      ...card,
      activeCount: backlog.ok ? backlog.data.items.Active.length : 0,
      queueCount: backlog.ok ? backlog.data.items.Queue.length : 0,
      findingCount: findings.ok ? findings.data.length : 0,
      reviewCount: review.ok ? review.data.length : 0,
    };
  });
}

function renderProjectsDashboard(ctx: ViewContext, entries: ProjectDashboardEntry[], height: number): string[] {
  const runtime = readRuntimeHealth(ctx.cortexPath);
  const scoped = entries.filter((entry) => entry.name !== "global");
  const totals = scoped.reduce((acc, entry) => {
    acc.active += entry.activeCount;
    acc.queue += entry.queueCount;
    acc.findings += entry.findingCount;
    acc.review += entry.reviewCount;
    return acc;
  }, { active: 0, queue: 0, findings: 0, review: 0 });

  const activePreview = scoped
    .filter((entry) => entry.activeCount > 0 || entry.queueCount > 0)
    .slice(0, 3)
    .map((entry) => `${style.bold(entry.name)} ${style.dim(`A${entry.activeCount} · Q${entry.queueCount}`)}`);
  const findingsPreview = scoped
    .filter((entry) => entry.findingCount > 0)
    .slice(0, 3)
    .map((entry) => `${style.bold(entry.name)} ${style.dim(`${entry.findingCount} findings`)}`);

  const lines = [
    `  ${badge(ctx.profile || "default", style.boldBlue)}  ${style.bold(String(scoped.length))} projects  ${style.dim("·")}  ${style.boldGreen(String(totals.active))} active  ${style.dim("·")}  ${style.boldYellow(String(totals.queue))} queued  ${style.dim("·")}  ${style.boldCyan(String(totals.findings))} findings  ${style.dim("·")}  ${style.boldMagenta(String(totals.review))} review`,
    ctx.state.project
      ? `  ${style.green("●")} active context ${style.boldCyan(ctx.state.project)}  ${style.dim("· ↵ opens selected project tasks")}`
      : `  ${style.dim("No project selected yet")}  ${style.dim("· ↵ sets context and opens tasks")}`,
    `  ${style.dim("Sync")} ${style.dim(runtime.lastSync?.lastPushStatus || runtime.lastAutoSave?.status || "unknown")}  ${style.dim("·")}  ${style.dim("unsynced")} ${style.bold(String(runtime.lastSync?.unsyncedCommits ?? 0))}  ${style.dim("·")}  ${style.dim("intro")} ${style.cyan(ctx.state.introMode || "once-per-version")}`,
  ];

  if (height >= 12) {
    lines.push("");
    lines.push(`  ${style.bold("Task pulse")}  ${activePreview.length ? activePreview.join(style.dim("  ·  ")) : style.dim("No active tasks across this profile.")}`);
    lines.push(`  ${style.bold("Recent findings")}  ${findingsPreview.length ? findingsPreview.join(style.dim("  ·  ")) : style.dim("No findings yet.")}`);
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
    const docsStr = style.dim(`[A${card.activeCount} · Q${card.queueCount} · F${card.findingCount} · R${card.reviewCount}]`);

    let nameRow = `  ${cursorChar} ${bullet} ${nameStr}  ${docsStr}`;
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

// ── Backlog helpers ────────────────────────────────────────────────────────

function sectionBullet(title: string): { bullet: string; colorFn: (s: string) => string } {
  switch (title) {
    case "Active": return { bullet: style.green("●"), colorFn: style.boldGreen };
    case "Queue": return { bullet: style.yellow("●"), colorFn: style.boldYellow };
    case "Done": return { bullet: style.gray("●"), colorFn: style.dim };
    default: return { bullet: "●", colorFn: style.bold };
  }
}

export interface SubsectionsCache {
  project: string;
  /** Keys are stable item IDs (bid hash when present, else "row:N") mapped to subsection name */
  map: Map<string, string>;
}

const BID_RE = /<!--\s*bid:([a-z0-9]{8})\s*-->/;

function parseSubsections(backlogPath: string, project: string, cache: SubsectionsCache | null): { map: Map<string, string>; cache: SubsectionsCache } {
  if (cache?.project === project) return { map: cache.map, cache };
  const map = new Map<string, string>();
  try {
    const raw = fs.readFileSync(backlogPath, "utf8");
    let currentSub = "";
    let rowIdx = 0;
    for (const line of raw.split("\n")) {
      const subMatch = line.match(/^###\s+(.+)/);
      if (subMatch) { currentSub = subMatch[1].trim(); continue; }
      if (line.match(/^##\s/)) { currentSub = ""; continue; }
      if (line.startsWith("- ")) {
        if (currentSub) {
          const bidMatch = line.match(BID_RE);
          const key = bidMatch ? bidMatch[1] : `row:${rowIdx}`;
          map.set(key, currentSub);
        }
        rowIdx++;
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] buildSubsectionMap: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  const newCache = { project, map };
  return { map, cache: newCache };
}

// ── Tasks view ─────────────────────────────────────────────────────────────

function renderBacklogView(ctx: ViewContext, cursor: number, height: number, subsectionsCache: SubsectionsCache | null): { lines: string[]; subsectionsCache: SubsectionsCache | null } {
  const cols = renderWidth();
  const project = ctx.state.project;
  if (!project) {
    return { lines: [style.dim("  No project selected — navigate to Projects (← →) and press ↵")], subsectionsCache };
  }

  const result = readBacklog(ctx.cortexPath, project);
  if (!result.ok) return { lines: [result.error], subsectionsCache };

  const parsed = result.data;
  const warnings = parsed.issues.length
    ? [`  ${style.yellow("⚠")}  ${style.yellow(parsed.issues.join("; "))}`, ""]
    : [];

  const backlogFile = resolveTaskFilePath(ctx.cortexPath, project)
    ?? canonicalTaskFilePath(ctx.cortexPath, project)
    ?? path.join(ctx.cortexPath, project, "tasks.md");
  const subsResult = parseSubsections(backlogFile, project, subsectionsCache);
  const subsections = subsResult.map;
  const newCache = subsResult.cache;

  const active = ctx.state.filter ? backlogsByFilter(parsed.items.Active, ctx.state.filter) : parsed.items.Active;
  const queue = ctx.state.filter ? backlogsByFilter(parsed.items.Queue, ctx.state.filter) : parsed.items.Queue;
  const done = ctx.state.filter ? backlogsByFilter(parsed.items.Done, ctx.state.filter) : parsed.items.Done;
  const flatItems = [...active, ...queue, ...done];

  if (!flatItems.length) {
    const hint = ctx.state.filter ? "  No items match the filter." : `  No tasks yet. Press ${style.boldCyan("a")} to add one.`;
    return { lines: [...warnings, style.dim(hint)], subsectionsCache: newCache };
  }

  const queueStart = active.length;
  const doneStart = active.length + queue.length;

  const allLines: string[] = [];
  let cursorFirstLine = 0;
  let cursorLastLine = 0;
  let lastSection = "";
  let lastSub = "";

  for (let absIdx = 0; absIdx < flatItems.length; absIdx++) {
    const item = flatItems[absIdx];
    const isSelected = absIdx === cursor;
    const isDone = absIdx >= doneStart;

    const section = absIdx < queueStart ? "Active" : absIdx < doneStart ? "Queue" : "Done";
    if (section !== lastSection) {
      lastSection = section;
      lastSub = "";
      const { bullet, colorFn } = sectionBullet(section);
      allLines.push(`  ${bullet} ${colorFn(section)}`);
    }

    const sub = (item.stableId ? subsections.get(item.stableId) : undefined) ?? subsections.get(`row:${absIdx}`) ?? "";
    if (sub && sub !== lastSub) {
      lastSub = sub;
      allLines.push(`    ${style.boldYellow(sub)}`);
    }

    if (isSelected) cursorFirstLine = allLines.length;

    const idStr = style.dim(item.id);
    const pinTag = item.pinned ? ` ${style.boldCyan("[pin]")}` : "";
    const prioTag = item.priority && !isDone
      ? ` ${item.priority === "high"
        ? style.boldRed(`[${item.priority}]`)
        : item.priority === "medium"
          ? style.yellow(`[${item.priority}]`)
          : style.dim(`[${item.priority}]`)}`
      : "";
    const check = item.checked ? style.green("[✓]") : style.dim("[ ]");
    const lineText = isDone ? style.dim(item.line) : item.line;

    let row = `    ${idStr} ${check} ${lineText}${pinTag}${prioTag}`;
    row = isSelected && !isDone
      ? formatSelectableLine(row, cols, true)
      : truncateLine(row, cols);
    allLines.push(row);

    if (item.context) {
      const ctxLine = `       ${style.dimItalic("→ " + item.context)}`;
      allLines.push(isSelected && !isDone ? formatSelectableLine(ctxLine, cols, true) : truncateLine(ctxLine, cols));
    }

    if (isSelected) cursorLastLine = allLines.length - 1;
  }

  const usableHeight = Math.max(1, height - warnings.length - (allLines.length > height ? 1 : 0));
  const vp = viewportWithStatus(
    allLines,
    cursorFirstLine,
    cursorLastLine,
    usableHeight,
    ctx.currentScroll(),
    cursor,
    active.length + queue.length,
  );
  ctx.setScroll(vp.scrollStart);
  return { lines: [...warnings, ...vp.lines], subsectionsCache: newCache };
}

// ── Findings view ──────────────────────────────────────────────────────────

function renderFindingsView(ctx: ViewContext, cursor: number, height: number): string[] {
  const cols = renderWidth();
  const project = ctx.state.project;
  if (!project) return [style.dim("  No project selected.")];

  const result = readFindings(ctx.cortexPath, project);
  if (!result.ok) return [result.error];

  const all = result.data;
  const filtered = ctx.state.filter
    ? all.filter((item) =>
      `${item.id} ${item.date} ${item.text}`.toLowerCase().includes(ctx.state.filter!.toLowerCase()),
    )
    : all;

  if (!filtered.length) {
    return [style.dim(`  No findings yet. Press ${style.boldCyan("a")} to add one.`)];
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

  const result = readReviewQueue(ctx.cortexPath, project);
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
}

export function getProjectSkills(cortexPath: string, project: string): SkillEntry[] {
  return getScopedSkills(cortexPath, "", project).map((skill) => ({
    name: skill.name,
    path: skill.path,
    enabled: skill.enabled,
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

  const skills = getProjectSkills(ctx.cortexPath, project);
  const filtered = ctx.state.filter
    ? skills.filter((s) => s.name.toLowerCase().includes(ctx.state.filter!.toLowerCase()))
    : skills;

  if (!filtered.length) {
    return [style.dim(`  No skills for ${project}. Use "cortex skills add ${project} <path>" to add one.`)];
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
  { event: "Stop",             description: "auto-save findings after each response" },
  { event: "SessionStart",     description: "git pull at session start" },
];

export function getHookEntries(cortexPath: string, project?: string | null): HookEntry[] {
  const prefs = readInstallPreferences(cortexPath);
  const hooksEnabled = prefs.hooksEnabled !== false;
  const projectConfig = project ? readProjectConfig(cortexPath, project) : undefined;
  return LIFECYCLE_HOOKS.map((h) => ({
    ...h,
    enabled: hooksEnabled && isProjectHookEnabled(cortexPath, project, h.event as typeof PROJECT_HOOK_EVENTS[number], projectConfig),
  }));
}

function renderHooksView(ctx: ViewContext, cursor: number, height: number): string[] {
  const cols = renderWidth();
  const entries = getHookEntries(ctx.cortexPath, ctx.state.project);
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

export { writeInstallPreferences } from "./init-preferences.js";

// ── Machines/Profiles view ─────────────────────────────────────────────────

function renderMachinesView(cortexPath: string): string[] {
  const machines = listMachines(cortexPath);
  const profiles = listProfiles(cortexPath);
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
  cortexPath: string,
  doctor: DoctorResultLike,
  cursor: number,
  height: number,
  currentScroll: number,
  setScroll: (n: number) => void,
): { lines: string[]; lineCount: number } {
  const runtime = readRuntimeHealth(cortexPath);
  const allLines: string[] = [];

  const statusIcon = doctor.ok ? style.green("✓") : style.red("✗");
  const statusLabel = doctor.ok ? style.boldGreen("healthy") : style.boldRed("issues found");
  allLines.push(`  ${statusIcon}  ${style.bold("cortex")} ${statusLabel}`);
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
  message: string,
  doctorSnapshot: () => Promise<DoctorResultLike>,
  subsectionsCache: SubsectionsCache | null,
  setHealthLineCount: (n: number) => void,
  setSubsectionsCache: (c: SubsectionsCache | null) => void,
): Promise<string> {
  const projectLabel = ctx.state.project
    ? `  ${style.dim("·")}  ${style.cyan(ctx.state.project)}`
    : "";
  const filterLabel = ctx.state.filter
    ? `  ${style.dim("·")}  ${style.yellow("/" + ctx.state.filter)}`
    : "";
  const header = `  ${gradient("◆ cortex")}${projectLabel}${filterLabel}`;
  const tabBar = renderTabBar(ctx.state);
  const bottomBar = renderBottomBar(ctx.state, navMode, inputCtx, inputBuf);
  const cursor = ctx.currentCursor();
  const height = contentHeight(tabBar, bottomBar);

  let contentLines: string[];
  if (showHelp) {
    contentLines = shellHelpText().split("\n");
  } else {
    switch (ctx.state.view) {
      case "Projects":
        contentLines = renderProjectsView(ctx, cursor, height);
        break;
      case "Tasks": {
        const result = renderBacklogView(ctx, cursor, height, subsectionsCache);
        contentLines = result.lines;
        setSubsectionsCache(result.subsectionsCache);
        break;
      }
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
        contentLines = renderMachinesView(ctx.cortexPath);
        break;
      case "Health": {
        const doctor = await doctorSnapshot();
        const result = renderHealthView(ctx.cortexPath, doctor, cursor, height, ctx.currentScroll(), ctx.setScroll);
        contentLines = result.lines;
        setHealthLineCount(result.lineCount);
        break;
      }
      default:
        contentLines = ["  Unknown view."];
    }
  }

  const displayed = contentLines.slice(0, height);
  while (displayed.length < height) displayed.push("");

  const msgLine = `  ${style.dimItalic(stripAnsi(message).trimStart() ? message : "")}`;

  const cols = renderWidth();
  const parts = [header, tabBar, ...displayed, msgLine, bottomBar];
  return parts.map(line => {
    if (line.includes("\n")) {
      return line.split("\n").map(sub => truncateLine(sub, cols) + "\x1b[K").join("\n");
    }
    return truncateLine(line, cols) + "\x1b[K";
  }).join("\n");
}
