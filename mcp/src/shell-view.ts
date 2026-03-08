/**
 * View rendering functions for the cortex interactive shell.
 * Extracted from shell.ts to keep the orchestrator under 300 lines.
 */

import * as fs from "fs";
import * as path from "path";
import {
  BacklogItem,
  listProjectCards,
  readBacklog,
  readFindings,
  readReviewQueue,
  readRuntimeHealth,
  ShellState,
} from "./data-access.js";
import {
  RESET,
  style,
  badge,
  separator,
  stripAnsi,
  padToWidth,
  truncateLine,
  lineViewport,
  shellHelpText,
} from "./shell-render.js";
import {
  SUB_VIEWS,
  TAB_ICONS,
  type ShellView,
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
import { readInstallPreferences, writeInstallPreferences } from "./init-preferences.js";

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

export function renderTabBar(state: ShellState): string {
  const cols = process.stdout.columns || 80;

  if (state.view === "Health") {
    const label = `${TAB_ICONS.Health} Health`;
    return `  ${style.boldCyan(label)}\n${separator(cols)}`;
  }

  if (state.view === "Projects") {
    const label = `${TAB_ICONS.Projects} Projects`;
    const tabLine = ` ${style.boldCyan(label)} `;
    return `${tabLine}\n${separator(cols)}`;
  }

  const projectTag = state.project
    ? `${style.cyan(state.project)} ${style.dim("›")} `
    : "";
  const tabs = SUB_VIEWS.map((v) => {
    const icon = TAB_ICONS[v] || "";
    const label = `${icon} ${v}`;
    return v === state.view
      ? ` ${style.boldCyan(label)} `
      : ` ${style.dim(label)} `;
  });

  const tabLine = `  ${projectTag}${tabs.join(style.dim("│"))}`;
  return `${tabLine}\n${separator(cols)}`;
}

// ── Bottom bar ─────────────────────────────────────────────────────────────

export function renderBottomBar(state: ShellState, navMode: "navigate" | "input", inputCtx: string, inputBuf: string): string {
  const cols = process.stdout.columns || 80;
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
    Projects: [`${k("↵")} ${d("open project")}`],
    Backlog: [`${k("a")} ${d("add")}`, `${k("↵")} ${d("mark done")}`, `${k("d")} ${d("toggle active")}`],
    Findings: [`${k("a")} ${d("add")}`, `${k("d")} ${d("remove")}`],
    "Review Queue": [`${k("a")} ${d("keep")}`, `${k("d")} ${d("discard")}`, `${k("e")} ${d("edit")}`],
    Skills: [`${k("d")} ${d("remove")}`],
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
  return `${sep}\n  ${hints.join(dot)}`;
}

// ── Content height ─────────────────────────────────────────────────────────

export function contentHeight(): number {
  const rows = process.stdout.rows || 24;
  return Math.max(4, rows - 7);
}

// ── Projects view ──────────────────────────────────────────────────────────

export function renderProjectsView(ctx: ViewContext, cursor: number, height: number): string[] {
  const cols = process.stdout.columns || 80;
  const cards = listProjectCards(ctx.cortexPath, ctx.profile);
  const filtered = ctx.state.filter
    ? cards.filter((c) =>
      `${c.name} ${c.summary} ${c.docs.join(" ")}`.toLowerCase().includes(ctx.state.filter!.toLowerCase()),
    )
    : cards;

  if (!filtered.length) {
    return [style.dim("  No projects in this profile.")];
  }

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
    const docsStr = style.dim(`[${card.docs.join(" · ") || "no docs"}]`);

    let nameRow = `  ${cursorChar} ${bullet} ${nameStr}  ${docsStr}`;
    let summaryRow = `        ${style.dim(card.summary || "")}`;

    if (isSelected) {
      nameRow = `\x1b[7m${padToWidth(nameRow, cols)}${RESET}`;
      summaryRow = `\x1b[7m${padToWidth(summaryRow, cols)}${RESET}`;
    }

    allLines.push(nameRow);
    allLines.push(summaryRow);
    if (isSelected) cursorLastLine = allLines.length - 1;
  }

  const usableHeight = Math.max(1, height - (allLines.length > height ? 1 : 0));
  const vp = lineViewport(allLines, cursorFirstLine, cursorLastLine, usableHeight, ctx.currentScroll());
  ctx.setScroll(vp.scrollStart);
  const lines = vp.lines;

  if (allLines.length > usableHeight) {
    const pct = filtered.length <= 1 ? 100 : Math.round((cursor / (filtered.length - 1)) * 100);
    lines.push(style.dim(`  ─── ${cursor + 1}/${filtered.length}  ${pct}%`));
  }

  return lines;
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

export function parseSubsections(backlogPath: string, project: string, cache: SubsectionsCache | null): { map: Map<string, string>; cache: SubsectionsCache } {
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
  } catch { /* best effort */ }
  const newCache = { project, map };
  return { map, cache: newCache };
}

// ── Backlog view ───────────────────────────────────────────────────────────

export function renderBacklogView(ctx: ViewContext, cursor: number, height: number, subsectionsCache: SubsectionsCache | null): { lines: string[]; subsectionsCache: SubsectionsCache | null } {
  const cols = process.stdout.columns || 80;
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

  const backlogFile = path.join(ctx.cortexPath, project, "backlog.md");
  const subsResult = parseSubsections(backlogFile, project, subsectionsCache);
  const subsections = subsResult.map;
  const newCache = subsResult.cache;

  const active = ctx.state.filter ? backlogsByFilter(parsed.items.Active, ctx.state.filter) : parsed.items.Active;
  const queue = ctx.state.filter ? backlogsByFilter(parsed.items.Queue, ctx.state.filter) : parsed.items.Queue;
  const done = ctx.state.filter ? backlogsByFilter(parsed.items.Done, ctx.state.filter) : parsed.items.Done;
  const flatItems = [...active, ...queue, ...done];

  if (!flatItems.length) {
    const hint = ctx.state.filter ? "  No items match the filter." : `  No backlog items. Press ${style.boldCyan("a")} to add one.`;
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
    if (isSelected && !isDone) row = `\x1b[7m${padToWidth(row, cols)}${RESET}`;
    else row = truncateLine(row, cols);
    allLines.push(row);

    if (item.context) {
      const ctxLine = `       ${style.dimItalic("→ " + item.context)}`;
      allLines.push(isSelected && !isDone ? `\x1b[7m${padToWidth(ctxLine, cols)}${RESET}` : truncateLine(ctxLine, cols));
    }

    if (isSelected) cursorLastLine = allLines.length - 1;
  }

  const usableHeight = Math.max(1, height - warnings.length - (allLines.length > height ? 1 : 0));
  const vp = lineViewport(allLines, cursorFirstLine, cursorLastLine, usableHeight, ctx.currentScroll());
  ctx.setScroll(vp.scrollStart);
  const lines: string[] = [...warnings, ...vp.lines];

  if (allLines.length > usableHeight) {
    const navigable = active.length + queue.length;
    const pct = navigable <= 1 ? 100 : Math.round((cursor / Math.max(navigable - 1, 1)) * 100);
    lines.push(style.dim(`  ─── ${cursor + 1}/${navigable}  ${pct}%`));
  }

  return { lines, subsectionsCache: newCache };
}

// ── Findings view ──────────────────────────────────────────────────────────

export function renderFindingsView(ctx: ViewContext, cursor: number, height: number): string[] {
  const cols = process.stdout.columns || 80;
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
    if (isSelected) row = `\x1b[7m${padToWidth(row, cols)}${RESET}`;
    else row = truncateLine(row, cols);
    allLines.push(row);

    if (item.citation) {
      const cite = `              ${style.italic(style.blue("↗ " + item.citation))}`;
      allLines.push(isSelected ? `\x1b[7m${padToWidth(cite, cols)}${RESET}` : truncateLine(cite, cols));
    }

    if (isSelected) cursorLastLine = allLines.length - 1;
  }

  const usableHeight = Math.max(1, height - (allLines.length > height ? 1 : 0));
  const vp = lineViewport(allLines, cursorFirstLine, cursorLastLine, usableHeight, ctx.currentScroll());
  ctx.setScroll(vp.scrollStart);

  if (allLines.length > usableHeight) {
    const pct = filtered.length <= 1 ? 100 : Math.round((cursor / (filtered.length - 1)) * 100);
    vp.lines.push(style.dim(`  ─── ${cursor + 1}/${filtered.length}  ${pct}%`));
  }

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

export function renderMemoryQueueView(ctx: ViewContext, cursor: number, height: number): string[] {
  const cols = process.stdout.columns || 80;
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
      metaRow = `\x1b[7m${padToWidth(metaRow, cols)}${RESET}`;
      textRow = `\x1b[7m${padToWidth(textRow, cols)}${RESET}`;
    } else {
      metaRow = truncateLine(metaRow, cols);
      textRow = truncateLine(textRow, cols);
    }

    allLines.push(metaRow);
    allLines.push(textRow);

    if (isSelected) cursorLastLine = allLines.length - 1;
  }

  const usableHeight = Math.max(1, height - (allLines.length > height ? 1 : 0));
  const vp = lineViewport(allLines, cursorFirstLine, cursorLastLine, usableHeight, ctx.currentScroll());
  ctx.setScroll(vp.scrollStart);

  if (allLines.length > usableHeight) {
    const pct = filtered.length <= 1 ? 100 : Math.round((cursor / (filtered.length - 1)) * 100);
    vp.lines.push(style.dim(`  ─── ${cursor + 1}/${filtered.length}  ${pct}%`));
  }

  return vp.lines;
}

// ── Skills view ────────────────────────────────────────────────────────────

export interface SkillEntry {
  name: string;
  path: string;
}

export function getProjectSkills(cortexPath: string, project: string): SkillEntry[] {
  const dirs = [
    path.join(cortexPath, project, "skills"),
    path.join(cortexPath, project, ".claude", "skills"),
  ];
  const seen = new Set<string>();
  const skills: SkillEntry[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const name = entry.name.replace(/\.md$/, "");
        if (!seen.has(name)) { seen.add(name); skills.push({ name, path: path.join(dir, entry.name) }); }
      } else if (entry.isDirectory()) {
        const skillFile = path.join(dir, entry.name, "SKILL.md");
        if (fs.existsSync(skillFile) && !seen.has(entry.name)) {
          seen.add(entry.name); skills.push({ name: entry.name, path: skillFile });
        }
      }
    }
  }
  return skills;
}

export function renderSkillsView(ctx: ViewContext, cursor: number, height: number): string[] {
  const cols = process.stdout.columns || 80;
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
    let row = `  ${style.dim((i + 1).toString().padEnd(3))} ${style.bold(s.name)}${linkTag}`;
    if (isSelected) row = `\x1b[7m${padToWidth(row, cols)}${RESET}`;
    else row = truncateLine(row, cols);
    allLines.push(row);

    if (isSelected) cursorLastLine = allLines.length - 1;
  }

  const usableHeight = Math.max(1, height - (allLines.length > height ? 1 : 0));
  const vp = lineViewport(allLines, cursorFirstLine, cursorLastLine, usableHeight, ctx.currentScroll());
  ctx.setScroll(vp.scrollStart);

  if (allLines.length > usableHeight) {
    const pct = filtered.length <= 1 ? 100 : Math.round((cursor / (filtered.length - 1)) * 100);
    vp.lines.push(style.dim(`  ─── ${cursor + 1}/${filtered.length}  ${pct}%`));
  }

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

export function getHookEntries(cortexPath: string): HookEntry[] {
  const prefs = readInstallPreferences(cortexPath);
  const hooksEnabled = prefs.hooksEnabled !== false;
  return LIFECYCLE_HOOKS.map((h) => ({ ...h, enabled: hooksEnabled }));
}

export function renderHooksView(ctx: ViewContext, cursor: number, height: number): string[] {
  const cols = process.stdout.columns || 80;
  const entries = getHookEntries(ctx.cortexPath);
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
      nameRow = `\x1b[7m${padToWidth(nameRow, cols)}${RESET}`;
      descRow = `\x1b[7m${padToWidth(descRow, cols)}${RESET}`;
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
  const vp = lineViewport(allLines, cursorFirstLine, cursorLastLine, usableHeight, ctx.currentScroll());
  ctx.setScroll(vp.scrollStart);

  return vp.lines;
}

export { writeInstallPreferences } from "./init-preferences.js";

// ── Machines/Profiles view ─────────────────────────────────────────────────

export function renderMachinesView(cortexPath: string): string[] {
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

export function renderHealthView(
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

  allLines.push("", `  ${style.dim(":run fix  :relink  :rerun hooks  :update")}`);

  const lineCount = allLines.length;
  if (allLines.length <= height) return { lines: allLines, lineCount };

  const cols = process.stdout.columns || 80;
  const clampedCursor = Math.max(0, Math.min(cursor, allLines.length - 1));
  allLines[clampedCursor] = `\x1b[7m${padToWidth(allLines[clampedCursor], cols)}${RESET}`;
  const vp = lineViewport(allLines, clampedCursor, clampedCursor, height - 1, currentScroll);
  setScroll(vp.scrollStart);
  const pct = allLines.length <= 1 ? 100 : Math.round((clampedCursor / (allLines.length - 1)) * 100);
  vp.lines.push(style.dim(`  ─── ${clampedCursor + 1}/${allLines.length}  ${pct}%`));
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
  const cols = process.stdout.columns || 80;
  const cursor = ctx.currentCursor();
  const height = contentHeight();

  const projectLabel = ctx.state.project
    ? `  ${style.dim("·")}  ${style.cyan(ctx.state.project)}`
    : "";
  const filterLabel = ctx.state.filter
    ? `  ${style.dim("·")}  ${style.yellow("/" + ctx.state.filter)}`
    : "";
  const header = `  ${style.boldCyan("◆ cortex")}${projectLabel}${filterLabel}`;
  const tabBar = renderTabBar(ctx.state);

  let contentLines: string[];
  if (showHelp) {
    contentLines = shellHelpText().split("\n");
  } else {
    switch (ctx.state.view) {
      case "Projects":
        contentLines = renderProjectsView(ctx, cursor, height);
        break;
      case "Backlog": {
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
  const bottomBar = renderBottomBar(ctx.state, navMode, inputCtx, inputBuf);

  const parts = [header, tabBar, ...displayed, msgLine, bottomBar];
  return parts.map(line => {
    if (line.includes("\n")) {
      return line.split("\n").map(sub => sub + "\x1b[K").join("\n");
    }
    return line + "\x1b[K";
  }).join("\n") + "\n";
}
