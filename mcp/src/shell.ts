import * as readline from "readline";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  addBacklogItem,
  addLearning,
  addProjectToProfile,
  approveMemoryQueueItem,
  BacklogItem,
  completeBacklogItem,
  editMemoryQueueItem,
  listMachines,
  listProfiles,
  listProjectCards,
  loadShellState,
  QueueItem,
  readBacklog,
  readLearnings,
  readMemoryQueue,
  readRuntimeHealth,
  rejectMemoryQueueItem,
  removeLearning,
  removeProjectFromProfile,
  resetShellState,
  saveShellState,
  setMachineProfile,
  ShellState,
  tidyBacklogDone,
  updateBacklogItem,
  workNextBacklogItem,
} from "./data-access.js";
import { runDoctor, runLink } from "./link.js";
import { runCortexUpdate } from "./update.js";

// ── ANSI color utilities ────────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

const style = {
  bold: (s: string) => `${ESC}1m${s}${RESET}`,
  dim: (s: string) => `${ESC}2m${s}${RESET}`,
  italic: (s: string) => `${ESC}3m${s}${RESET}`,
  cyan: (s: string) => `${ESC}36m${s}${RESET}`,
  green: (s: string) => `${ESC}32m${s}${RESET}`,
  yellow: (s: string) => `${ESC}33m${s}${RESET}`,
  red: (s: string) => `${ESC}31m${s}${RESET}`,
  magenta: (s: string) => `${ESC}35m${s}${RESET}`,
  blue: (s: string) => `${ESC}34m${s}${RESET}`,
  white: (s: string) => `${ESC}37m${s}${RESET}`,
  gray: (s: string) => `${ESC}90m${s}${RESET}`,
  boldCyan: (s: string) => `${ESC}1;36m${s}${RESET}`,
  boldGreen: (s: string) => `${ESC}1;32m${s}${RESET}`,
  boldYellow: (s: string) => `${ESC}1;33m${s}${RESET}`,
  boldRed: (s: string) => `${ESC}1;31m${s}${RESET}`,
  boldMagenta: (s: string) => `${ESC}1;35m${s}${RESET}`,
  boldBlue: (s: string) => `${ESC}1;34m${s}${RESET}`,
  dimItalic: (s: string) => `${ESC}2;3m${s}${RESET}`,
};

function badge(label: string, colorFn: (s: string) => string): string {
  return colorFn(`[${label}]`);
}

function box(content: string[], width = 50): string[] {
  const lines: string[] = [];
  const inner = width - 2;
  lines.push(style.dim(`╭${"─".repeat(inner)}╮`));
  for (const line of content) {
    // Pad without counting ANSI escapes toward width
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
    const pad = Math.max(0, inner - stripped.length);
    lines.push(style.dim("│") + line + " ".repeat(pad) + style.dim("│"));
  }
  lines.push(style.dim(`╰${"─".repeat(inner)}╯`));
  return lines;
}

function separator(width = 50): string {
  return style.dim("─".repeat(width));
}

function highlightKey(key: string, label: string): string {
  return style.boldCyan(`[${key}]`) + style.dim(label);
}

// ── End ANSI utilities ──────────────────────────────────────────────────────

export type ShellView = ShellState["view"];

export interface ShellDeps {
  runDoctor: typeof runDoctor;
  runRelink: (cortexPath: string) => Promise<string>;
  runHooks: (cortexPath: string) => Promise<string>;
  runUpdate: () => Promise<string>;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface DoctorResultLike {
  ok: boolean;
  machine?: string;
  profile?: string;
  checks: DoctorCheck[];
}

function tokenize(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if ((ch === "\"" || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? null : ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function backlogsByFilter(items: BacklogItem[], filter: string): BacklogItem[] {
  const needle = filter.toLowerCase().trim();
  if (!needle) return items;
  return items.filter((item) => `${item.id} ${item.line} ${item.context || ""}`.toLowerCase().includes(needle));
}

function queueByFilter(items: QueueItem[], filter: string): QueueItem[] {
  const needle = filter.toLowerCase().trim();
  if (!needle) return items;
  return items.filter((item) => `${item.id} ${item.section} ${item.text}`.toLowerCase().includes(needle));
}

function perPageSlice<T>(items: T[], page: number, perPage: number): { pageItems: T[]; totalPages: number } {
  const safePerPage = Math.max(1, perPage);
  const safePage = Math.max(1, page);
  const totalPages = Math.max(1, Math.ceil(items.length / safePerPage));
  const bounded = Math.min(safePage, totalPages);
  const start = (bounded - 1) * safePerPage;
  return {
    pageItems: items.slice(start, start + safePerPage),
    totalPages,
  };
}

function normalizeSection(sectionRaw: string): "Active" | "Queue" | "Done" | null {
  const normalized = sectionRaw.toLowerCase();
  if (["active", "a"].includes(normalized)) return "Active";
  if (["queue", "queued", "q"].includes(normalized)) return "Queue";
  if (["done", "d"].includes(normalized)) return "Done";
  return null;
}

function shellHelpText(): string {
  const hdr = (s: string) => style.bold(style.white(s));
  const cmd = (s: string) => style.boldCyan(s);
  const desc = (s: string) => style.dim(s);

  return [
    "",
    hdr("Navigation"),
    `  ${highlightKey("p", "rojects")}  ${highlightKey("b", "acklog")}  ${highlightKey("l", "earnings")}  ${highlightKey("m", "emory")}  ${highlightKey("h", "ealth")}  ${highlightKey("q", "uit")}  ${style.boldCyan("/")}${style.dim("filter")}  ${style.boldCyan(":")}${style.dim("palette")}`,
    "",
    hdr("Palette Commands"),
    `  ${cmd(":open <project>")}                              ${desc("select active project context")}`,
    `  ${cmd(":add <task>")}                                  ${desc("add backlog item to queue")}`,
    `  ${cmd(":complete <task-id|match>")}                    ${desc("mark backlog item done")}`,
    `  ${cmd(":move <task-id|match> <active|queue|done>")}    ${desc("move backlog item")}`,
    `  ${cmd(":reprioritize <task-id|match> <high|medium|low>")}`,
    `  ${cmd(":context <task-id|match> <text>")}              ${desc("append/update context")}`,
    `  ${cmd(":work next")}                                   ${desc("move top queue item to active")}`,
    `  ${cmd(":tidy [keep]")}                                 ${desc("archive done items (default keep=30)")}`,
    "",
    hdr("Learnings"),
    `  ${cmd(":learn add <text>")}                            ${desc("append learning")}`,
    `  ${cmd(":learn remove <learning-id|match>")}            ${desc("remove learning")}`,
    "",
    hdr("Memory Queue"),
    `  ${cmd(":mq approve|reject <queue-id|match>")}          ${desc("memory queue triage")}`,
    `  ${cmd(":mq edit <queue-id|match> <text>")}             ${desc("edit memory queue item")}`,
    "",
    hdr("Governance"),
    `  ${cmd(":govern")}                                      ${desc("scan and queue stale/low-value memories")}`,
    `  ${cmd(":consolidate")}                                  ${desc("deduplicate LEARNINGS.md")}`,
    "",
    hdr("Infrastructure"),
    `  ${cmd(":machine map <hostname> <profile>")}            ${desc("safely edit machines.yaml")}`,
    `  ${cmd(":profile add-project <profile> <project>")}     ${desc("safely edit profile projects")}`,
    `  ${cmd(":profile remove-project <profile> <project>")}`,
    `  ${cmd(":run fix")}                                     ${desc("run doctor --fix")}`,
    `  ${cmd(":relink")}                                      ${desc("rerun cortex link")}`,
    `  ${cmd(":rerun hooks")}                                 ${desc("run lifecycle hooks now")}`,
    `  ${cmd(":update")}                                      ${desc("update cortex to latest")}`,
    `  ${cmd(":reset")}                                       ${desc("reset shell state")}`,
    "",
    hdr("Pagination"),
    `  ${cmd(":page next|prev|<n>")}                          ${desc("change pagination")}`,
    `  ${cmd(":per-page <n>")}                                ${desc("set rows per page")}`,
    `  ${cmd(":help")}                                        ${desc("show this help")}`,
  ].join("\n");
}

function resolveEntryScript(): string {
  const current = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(current), "index.js");
}

async function defaultRunHooks(cortexPath: string): Promise<string> {
  const entry = resolveEntryScript();
  execFileSync(process.execPath, [entry, "hook-session-start"], {
    cwd: cortexPath,
    stdio: "ignore",
    timeout: 30_000,
  });
  execFileSync(process.execPath, [entry, "hook-stop"], {
    cwd: cortexPath,
    stdio: "ignore",
    timeout: 30_000,
  });
  return "Lifecycle hooks rerun (session-start + stop).";
}

async function defaultRunUpdate(): Promise<string> {
  return runCortexUpdate();
}

async function defaultRunRelink(cortexPath: string): Promise<string> {
  await runLink(cortexPath, {
    register: false,
    allTools: true,
  });
  return "Relink completed for detected tools.";
}

export class CortexShell {
  private state: ShellState;
  private message = `Type ${style.boldCyan(":help")} for keyboard map and palette commands.`;
  private healthCache?: { at: number; result: DoctorResultLike };
  private showHelp = false;
  private pages: Partial<Record<ShellView, number>> = {};
  private pendingConfirm?: { label: string; action: () => void };

  constructor(
    private readonly cortexPath: string,
    private readonly profile: string,
    private readonly deps: ShellDeps = {
      runDoctor,
      runRelink: defaultRunRelink,
      runHooks: defaultRunHooks,
      runUpdate: defaultRunUpdate,
    }
  ) {
    this.state = loadShellState(cortexPath);
    const cards = listProjectCards(cortexPath, profile);
    if (!this.state.project && cards.length > 0) this.state.project = cards[0].name;
    if (!this.state.perPage) this.state.perPage = 40;
    if (!this.state.page) this.state.page = 1;
    this.pages[this.state.view] = this.state.page;
  }

  close(): void {
    saveShellState(this.cortexPath, this.state);
  }

  private setMessage(msg: string): void {
    this.message = msg;
  }

  private confirmThen(label: string, action: () => void): void {
    this.pendingConfirm = { label, action };
    this.setMessage(`${label} Confirm? (y/n)`);
  }

  private setView(view: ShellView): void {
    this.pages[this.state.view] = this.state.page || 1;
    this.state.view = view;
    this.state.page = this.pages[view] || 1;
    saveShellState(this.cortexPath, this.state);
  }

  private ensureProjectSelected(): string | null {
    const selected = this.state.project;
    if (!selected) {
      this.setMessage("Select a project first with :open <project> or from Projects view.");
      return null;
    }
    return selected;
  }

  private renderHeader(): string[] {
    const viewLabel = this.state.view;
    const projectLabel = this.state.project || "(none)";
    const filterLabel = this.state.filter || "(none)";

    const bannerContent = [
      `  ${style.boldCyan("cortex")} ${style.dim("interactive shell")}`,
    ];
    const lines = [
      ...box(bannerContent, 40),
      `  ${style.dim("Path:")} ${style.gray(this.cortexPath)}`,
      `  View: ${viewLabel} ${style.dim("|")} Project: ${projectLabel} ${style.dim("|")} Filter: ${this.state.filter ? style.yellow(filterLabel) : style.dim(filterLabel)}`,
      `  ${highlightKey("p", "rojects")} ${highlightKey("b", "acklog")} ${highlightKey("l", "earnings")} ${highlightKey("m", "emory")} ${highlightKey("h", "ealth")} ${highlightKey("q", "uit")} ${style.boldCyan("/")}${style.dim("filter")} ${style.boldCyan(":")}${style.dim("palette")}`,
      separator(60),
      "",
    ];
    return lines;
  }

  private renderProjectsView(): string[] {
    const lines: string[] = [style.bold("[Projects]"), ""];
    const cards = listProjectCards(this.cortexPath, this.profile);
    if (!cards.length) {
      lines.push(style.dim("No indexed projects in this profile."));
      return lines;
    }

    const filtered = this.state.filter
      ? cards.filter((card) => `${card.name} ${card.summary} ${card.docs.join(" ")}`.toLowerCase().includes(this.state.filter!.toLowerCase()))
      : cards;

    if (!filtered.length) {
      lines.push(style.dim("No projects matched current filter."));
      return lines;
    }

    for (const card of filtered) {
      const isActive = card.name === this.state.project;
      const bullet = isActive ? style.green("●") : style.dim("○");
      const name = isActive ? style.boldGreen(card.name) : style.bold(card.name);
      const docs = style.dim(`[${card.docs.join(" | ") || "no docs"}]`);
      lines.push(`${bullet} ${name}  ${docs}`);
      if (card.summary) lines.push(`    ${style.dim(card.summary)}`);
    }

    lines.push("", style.dim("Use :open <project> to pin context across all views."));
    return lines;
  }

  private sectionBullet(title: string): { bullet: string; colorFn: (s: string) => string } {
    switch (title) {
      case "Active": return { bullet: style.green("●"), colorFn: style.boldGreen };
      case "Queue": return { bullet: style.yellow("●"), colorFn: style.boldYellow };
      case "Done": return { bullet: style.gray("●"), colorFn: style.dim };
      default: return { bullet: "●", colorFn: style.bold };
    }
  }

  private renderBacklogSection(title: string, items: BacklogItem[], subsections?: Map<string, string>): string[] {
    const { bullet, colorFn } = this.sectionBullet(title);
    const lines: string[] = [`${bullet} ${colorFn(title + ":")}`];
    if (!items.length) {
      lines.push(`  ${style.dim("(empty)")}`);
      return lines;
    }

    const filtered = this.state.filter ? backlogsByFilter(items, this.state.filter) : items;
    if (!filtered.length) {
      lines.push(`  ${style.dim("(no matches under current filter)")}`);
      return lines;
    }

    const { pageItems, totalPages } = perPageSlice(filtered, this.state.page || 1, this.state.perPage || 40);
    let currentSub = "";
    for (const item of pageItems) {
      if (subsections) {
        const sub = subsections.get(item.line) || "";
        if (sub && sub !== currentSub) {
          currentSub = sub;
          lines.push(`  ${style.boldYellow(sub)}`);
        }
      }
      const id = style.dim(item.id);
      if (item.checked) {
        lines.push(`  ${id} ${style.green("[x]")} ${style.dim(item.line)}`);
      } else {
        lines.push(`  ${id} [ ] ${item.line}`);
      }
      if (item.context) lines.push(`    ${style.dimItalic("Context: " + item.context)}`);
    }
    if (totalPages > 1) {
      const pg = Math.min(this.state.page || 1, totalPages);
      lines.push(`  ${style.dim(`Page ${pg} / ${totalPages}`)}`);
    }
    return lines;
  }

  private parseSubsections(backlogPath: string): Map<string, string> {
    const map = new Map<string, string>();
    try {
      const raw = fs.readFileSync(backlogPath, "utf8");
      let currentSub = "";
      for (const line of raw.split("\n")) {
        const subMatch = line.match(/^###\s+(.+)/);
        if (subMatch) {
          currentSub = subMatch[1].trim();
          continue;
        }
        if (line.match(/^##\s/)) {
          currentSub = "";
          continue;
        }
        if (line.startsWith("- ")) {
          const body = line.replace(/^- \[[ x]\]\s*/, "").trim();
          if (currentSub && body) map.set(body, currentSub);
        }
      }
    } catch { /* best effort */ }
    return map;
  }

  private renderBacklogView(): string[] {
    const lines: string[] = [style.bold("[Backlog]"), ""];
    const project = this.state.project;
    if (!project) {
      lines.push(style.dim("No selected project. Use :open <project>."));
      return lines;
    }

    const parsed = readBacklog(this.cortexPath, project);
    if (typeof parsed === "string") {
      lines.push(parsed);
      return lines;
    }

    if (parsed.issues.length) {
      lines.push(`${style.yellow("Warnings:")} ${parsed.issues.join("; ")}`, "");
    }

    const backlogFile = path.join(this.cortexPath, project, "backlog.md");
    const subsections = this.parseSubsections(backlogFile);

    lines.push(...this.renderBacklogSection("Active", parsed.items.Active, subsections), "");
    lines.push(...this.renderBacklogSection("Queue", parsed.items.Queue, subsections), "");
    lines.push(...this.renderBacklogSection("Done", parsed.items.Done, subsections));
    return lines;
  }

  private renderLearningsView(): string[] {
    const lines: string[] = [style.bold("[Learnings]"), ""];
    const project = this.state.project;
    if (!project) {
      lines.push(style.dim("No selected project. Use :open <project>."));
      return lines;
    }

    const learnings = readLearnings(this.cortexPath, project);
    if (typeof learnings === "string") {
      lines.push(learnings);
      return lines;
    }

    if (!learnings.length) {
      lines.push(style.dim("No learning entries yet."));
      return lines;
    }

    const filtered = this.state.filter
      ? learnings.filter((item) => `${item.id} ${item.date} ${item.text}`.toLowerCase().includes(this.state.filter!.toLowerCase()))
      : learnings;

    const { pageItems, totalPages } = perPageSlice(filtered, this.state.page || 1, this.state.perPage || 40);
    for (const item of pageItems) {
      lines.push(`${style.dim(item.id)} ${style.dim(`[${item.date}]`)} ${item.text}`);
      if (item.citation) lines.push(`  ${style.italic(style.blue("citation: " + item.citation))}`);
    }
    if (totalPages > 1) {
      const pg = Math.min(this.state.page || 1, totalPages);
      lines.push(``, style.dim(`Page ${pg} / ${totalPages}`));
    }
    lines.push("", style.dim("Write with :learn add <text>, remove with :learn remove <id|match>"));
    return lines;
  }

  private queueSectionBadge(section: string): string {
    switch (section.toLowerCase()) {
      case "review": return badge(section, style.yellow);
      case "stale": return badge(section, style.red);
      case "conflicts": return badge(section, style.magenta);
      default: return badge(section, style.dim);
    }
  }

  private renderMemoryQueueView(): string[] {
    const lines: string[] = [style.bold("[Memory Queue]"), ""];
    const project = this.state.project;
    if (!project) {
      lines.push(style.dim("No selected project. Use :open <project>."));
      return lines;
    }

    const items = readMemoryQueue(this.cortexPath, project);
    if (typeof items === "string") {
      lines.push(items);
      return lines;
    }

    if (!items.length) {
      lines.push(style.dim("No queued memory items."));
      return lines;
    }

    const filtered = this.state.filter ? queueByFilter(items, this.state.filter) : items;
    const { pageItems, totalPages } = perPageSlice(filtered, this.state.page || 1, this.state.perPage || 40);

    let currentSection = "";
    for (const item of pageItems) {
      if (item.section !== currentSection) {
        currentSection = item.section;
        if (lines.length > 2) lines.push("");
        lines.push(`${this.queueSectionBadge(currentSection)} ${style.bold(currentSection)}`);
        lines.push(style.dim("─".repeat(40)));
      }
      const riskBadge = item.risky ? badge("risk", style.boldRed) : badge("ok", style.green);
      const conf = item.confidence !== undefined
        ? ` ${style.dim("conf=")}${item.confidence >= 0.8 ? style.green(item.confidence.toFixed(2)) : item.confidence >= 0.6 ? style.yellow(item.confidence.toFixed(2)) : style.red(item.confidence.toFixed(2))}`
        : "";
      lines.push(`  ${style.dim(item.id)} ${riskBadge} ${style.dim(`[${item.date}]`)}${conf}`);
      lines.push(`    ${item.text}`);
    }
    if (totalPages > 1) {
      const pg = Math.min(this.state.page || 1, totalPages);
      lines.push(``, style.dim(`Page ${pg} / ${totalPages}`));
    }
    lines.push("", style.dim("Actions: :mq approve <id> | :mq reject <id> | :mq edit <id> <text>"));
    return lines;
  }

  private renderMachinesView(): string[] {
    const lines: string[] = [style.bold("[Machines/Profiles]"), ""];
    const machines = listMachines(this.cortexPath);
    const profiles = listProfiles(this.cortexPath);

    lines.push(style.bold("Machines:"));
    if (typeof machines === "string") {
      lines.push(`  ${style.dim(machines)}`);
    } else {
      const entries = Object.entries(machines);
      if (!entries.length) lines.push(`  ${style.dim("(none)")}`);
      for (const [machine, profile] of entries) lines.push(`  ${style.bold(machine)} ${style.dim("→")} ${style.cyan(profile as string)}`);
    }

    lines.push("", style.bold("Profiles:"));
    if (typeof profiles === "string") {
      lines.push(`  ${style.dim(profiles)}`);
    } else {
      if (!profiles.length) lines.push(`  ${style.dim("(none)")}`);
      for (const profile of profiles) {
        lines.push(`  ${style.cyan(profile.name)}: ${profile.projects.join(", ") || style.dim("(no projects)")}`);
      }
    }

    lines.push(
      "",
      style.dim("Safe edit flow:"),
      `  ${style.boldCyan(":machine map")} ${style.dim("<hostname> <profile>")}`,
      `  ${style.boldCyan(":profile add-project")} ${style.dim("<profile> <project>")}`,
      `  ${style.boldCyan(":profile remove-project")} ${style.dim("<profile> <project>")}`
    );

    return lines;
  }

  private async doctorSnapshot(): Promise<DoctorResultLike> {
    if (this.healthCache && Date.now() - this.healthCache.at < 10_000) {
      return this.healthCache.result;
    }
    const result = await this.deps.runDoctor(this.cortexPath, false);
    this.healthCache = {
      at: Date.now(),
      result,
    };
    return result;
  }

  private async renderHealthView(): Promise<string[]> {
    const lines: string[] = [style.bold("[Health]"), ""];
    const doctor = await this.doctorSnapshot();
    const runtime = readRuntimeHealth(this.cortexPath);

    const statusLabel = doctor.ok ? style.boldGreen("ok") : style.boldRed("issues found");
    lines.push(`${style.bold("Doctor:")} ${statusLabel}`);
    if (doctor.machine) lines.push(`${style.dim("Machine:")} ${style.bold(doctor.machine)}`);
    if (doctor.profile) lines.push(`${style.dim("Profile:")} ${style.cyan(doctor.profile)}`);

    lines.push("", style.bold("Checks:"));
    for (const check of doctor.checks) {
      const icon = check.ok ? style.green("✓") : style.red("✗");
      const status = check.ok ? style.dim("ok") : style.boldRed("fail");
      lines.push(`  ${icon} ${status} ${check.name}: ${check.detail}`);
    }

    lines.push("", style.bold("Runtime:"));
    lines.push(`  ${style.dim("last hook run:")} ${style.dim(runtime.lastPromptAt || "n/a")}`);
    lines.push(`  ${style.dim("last auto-save:")} ${style.dim(runtime.lastAutoSave?.at || "n/a")} (${style.dim(runtime.lastAutoSave?.status || "n/a")})`);
    lines.push(`  ${style.dim("last governance:")} ${style.dim(runtime.lastGovernance?.at || "n/a")} (${style.dim(runtime.lastGovernance?.status || "n/a")})`);

    lines.push("", style.bold("Remediation commands:"));
    lines.push(`  ${style.boldCyan(":run fix")}      ${style.dim("(doctor --fix)")}`);
    lines.push(`  ${style.boldCyan(":relink")}       ${style.dim("(rebuild links/hooks)")}`);
    lines.push(`  ${style.boldCyan(":rerun hooks")}  ${style.dim("(session-start + stop)")}`);
    lines.push(`  ${style.boldCyan(":update")}       ${style.dim("(install latest cortex)")}`);

    return lines;
  }

  async render(): Promise<string> {
    const lines = this.renderHeader();
    if (this.showHelp) {
      lines.push(shellHelpText());
      lines.push("", `${style.dimItalic("Status:")} ${style.italic(this.message)}`);
      lines.push(style.dim("Press any key to dismiss."));
      return lines.join("\n") + "\n";
    }
    switch (this.state.view) {
      case "Projects":
        lines.push(...this.renderProjectsView());
        break;
      case "Backlog":
        lines.push(...this.renderBacklogView());
        break;
      case "Learnings":
        lines.push(...this.renderLearningsView());
        break;
      case "Memory Queue":
        lines.push(...this.renderMemoryQueueView());
        break;
      case "Machines/Profiles":
        lines.push(...this.renderMachinesView());
        break;
      case "Health":
        lines.push(...await this.renderHealthView());
        break;
      default:
        lines.push("Unknown view.");
    }

    lines.push("", `${style.dimItalic("Status:")} ${style.italic(this.message)}`);
    lines.push(style.dim("Type :help for command palette."));
    return lines.join("\n") + "\n";
  }

  private setFilter(value: string): void {
    this.state.filter = value.trim() || undefined;
    this.state.page = 1;
    saveShellState(this.cortexPath, this.state);
    this.setMessage(this.state.filter ? `Filter set to: ${this.state.filter}` : "Filter cleared.");
  }

  private async executePalette(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) return;
    const parts = tokenize(trimmed);
    const command = (parts[0] || "").toLowerCase();

    if (command === "help") {
      this.showHelp = true;
      this.setMessage("Showing help. Press any key to dismiss.");
      return;
    }

    if (command === "projects") {
      this.setView("Projects");
      this.setMessage("Projects view.");
      return;
    }
    if (command === "backlog") {
      this.setView("Backlog");
      this.setMessage("Backlog view.");
      return;
    }
    if (command === "learnings") {
      this.setView("Learnings");
      this.setMessage("Learnings view.");
      return;
    }
    if (command === "memory") {
      this.setView("Memory Queue");
      this.setMessage("Memory Queue view.");
      return;
    }
    if (command === "machines") {
      this.setView("Machines/Profiles");
      this.setMessage("Machines/Profiles view.");
      return;
    }
    if (command === "health") {
      this.healthCache = undefined;
      this.setView("Health");
      this.setMessage("Health view.");
      return;
    }

    if (command === "open") {
      const project = parts[1];
      if (!project) {
        this.setMessage("Usage: :open <project>");
        return;
      }
      const cards = listProjectCards(this.cortexPath, this.profile);
      if (!cards.some((card) => card.name === project)) {
        this.setMessage(`Unknown project: ${project}`);
        return;
      }
      this.state.project = project;
      saveShellState(this.cortexPath, this.state);
      this.setMessage(`Project context set to ${project}.`);
      return;
    }

    if (command === "add") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      const text = trimmed.slice("add".length).trim();
      if (!text) {
        this.setMessage("Usage: :add <task>");
        return;
      }
      this.setMessage(addBacklogItem(this.cortexPath, project, text));
      return;
    }

    if (command === "complete") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      const match = parts.slice(1).join(" ").trim();
      if (!match) {
        this.setMessage("Usage: :complete <task-id|match>");
        return;
      }
      this.confirmThen(`Complete "${match}"?`, () => {
        this.setMessage(completeBacklogItem(this.cortexPath, project, match));
      });
      return;
    }

    if (command === "move") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      if (parts.length < 3) {
        this.setMessage("Usage: :move <task-id|match> <active|queue|done>");
        return;
      }
      const section = normalizeSection(parts[parts.length - 1]);
      if (!section) {
        this.setMessage("Target section must be active|queue|done");
        return;
      }
      const match = parts.slice(1, -1).join(" ");
      this.setMessage(updateBacklogItem(this.cortexPath, project, match, { section }));
      return;
    }

    if (command === "reprioritize") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      if (parts.length < 3) {
        this.setMessage("Usage: :reprioritize <task-id|match> <high|medium|low>");
        return;
      }
      const priority = parts[parts.length - 1].toLowerCase();
      if (!["high", "medium", "low"].includes(priority)) {
        this.setMessage("Priority must be high|medium|low");
        return;
      }
      const match = parts.slice(1, -1).join(" ");
      this.setMessage(updateBacklogItem(this.cortexPath, project, match, { priority }));
      return;
    }

    if (command === "context") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      if (parts.length < 3) {
        this.setMessage("Usage: :context <task-id|match> <text>");
        return;
      }
      const match = parts[1];
      const context = parts.slice(2).join(" ");
      this.setMessage(updateBacklogItem(this.cortexPath, project, match, { context }));
      return;
    }

    if (command === "work" && parts[1]?.toLowerCase() === "next") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      this.setMessage(workNextBacklogItem(this.cortexPath, project));
      return;
    }

    if (command === "tidy") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      const keep = parts[1] ? Number.parseInt(parts[1], 10) : 30;
      this.setMessage(tidyBacklogDone(this.cortexPath, project, Number.isNaN(keep) ? 30 : keep));
      return;
    }

    if (command === "learn") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      const action = (parts[1] || "").toLowerCase();
      if (action === "add") {
        const text = trimmed.split(/\s+/).slice(2).join(" ").trim();
        if (!text) {
          this.setMessage("Usage: :learn add <text>");
          return;
        }
        this.setMessage(addLearning(this.cortexPath, project, text));
        return;
      }
      if (action === "remove") {
        const match = parts.slice(2).join(" ").trim();
        if (!match) {
          this.setMessage("Usage: :learn remove <learning-id|match>");
          return;
        }
        this.confirmThen(`Remove learning "${match}"?`, () => {
          this.setMessage(removeLearning(this.cortexPath, project!, match));
        });
        return;
      }
      this.setMessage("Usage: :learn add <text> | :learn remove <id|match>");
      return;
    }

    if (command === "mq") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      const action = (parts[1] || "").toLowerCase();
      if (action === "approve") {
        const match = parts.slice(2).join(" ").trim();
        if (!match) {
          this.setMessage("Usage: :mq approve <queue-id|match>");
          return;
        }
        this.setMessage(approveMemoryQueueItem(this.cortexPath, project, match));
        return;
      }
      if (action === "reject") {
        const match = parts.slice(2).join(" ").trim();
        if (!match) {
          this.setMessage("Usage: :mq reject <queue-id|match>");
          return;
        }
        this.confirmThen(`Reject "${match}"?`, () => {
          this.setMessage(rejectMemoryQueueItem(this.cortexPath, project!, match));
        });
        return;
      }
      if (action === "edit") {
        if (parts.length < 4) {
          this.setMessage("Usage: :mq edit <queue-id|match> <text>");
          return;
        }
        const match = parts[2];
        const text = parts.slice(3).join(" ");
        this.setMessage(editMemoryQueueItem(this.cortexPath, project, match, text));
        return;
      }
      this.setMessage("Usage: :mq approve|reject|edit ...");
      return;
    }

    if (command === "machine" && parts[1]?.toLowerCase() === "map") {
      if (parts.length < 4) {
        this.setMessage("Usage: :machine map <hostname> <profile>");
        return;
      }
      this.setMessage(setMachineProfile(this.cortexPath, parts[2], parts[3]));
      return;
    }

    if (command === "profile") {
      const action = (parts[1] || "").toLowerCase();
      const profile = parts[2];
      const project = parts[3];
      if (!profile || !project) {
        this.setMessage("Usage: :profile add-project|remove-project <profile> <project>");
        return;
      }
      if (action === "add-project") {
        this.setMessage(addProjectToProfile(this.cortexPath, profile, project));
        return;
      }
      if (action === "remove-project") {
        this.setMessage(removeProjectFromProfile(this.cortexPath, profile, project));
        return;
      }
      this.setMessage("Usage: :profile add-project|remove-project <profile> <project>");
      return;
    }

    if (command === "run" && parts[1]?.toLowerCase() === "fix") {
      this.setMessage("Running doctor --fix...");
      const doctor = await this.deps.runDoctor(this.cortexPath, true);
      this.healthCache = undefined;
      this.setMessage(`doctor --fix completed: ${doctor.ok ? "ok" : "issues remain"}`);
      return;
    }

    if (command === "relink") {
      this.setMessage("Running relink...");
      this.setMessage(await this.deps.runRelink(this.cortexPath));
      return;
    }

    if (command === "rerun" && parts[1]?.toLowerCase() === "hooks") {
      this.setMessage("Running lifecycle hooks...");
      this.setMessage(await this.deps.runHooks(this.cortexPath));
      this.healthCache = undefined;
      return;
    }

    if (command === "update") {
      this.setMessage("Checking for updates...");
      this.setMessage(await this.deps.runUpdate());
      return;
    }

    if (command === "govern") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      this.setMessage("Running governance scan...");
      try {
        const entry = resolveEntryScript();
        const out = execFileSync(process.execPath, [entry, "govern-memories", project], {
          cwd: this.cortexPath,
          encoding: "utf8",
          timeout: 60_000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        this.setMessage(out || "Governance scan completed.");
      } catch (err: any) {
        this.setMessage(`Governance failed: ${err?.message || err}`);
      }
      return;
    }

    if (command === "consolidate") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      this.setMessage("Consolidating learnings...");
      try {
        const entry = resolveEntryScript();
        const out = execFileSync(process.execPath, [entry, "consolidate-memories", project], {
          cwd: this.cortexPath,
          encoding: "utf8",
          timeout: 60_000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        this.setMessage(out || "Consolidation completed.");
      } catch (err: any) {
        this.setMessage(`Consolidation failed: ${err?.message || err}`);
      }
      return;
    }

    if (command === "reset") {
      this.setMessage(resetShellState(this.cortexPath));
      this.state = loadShellState(this.cortexPath);
      const cards = listProjectCards(this.cortexPath, this.profile);
      this.state.project = cards[0]?.name;
      this.state.perPage = this.state.perPage || 40;
      this.state.page = this.state.page || 1;
      return;
    }

    if (command === "page") {
      const arg = (parts[1] || "").toLowerCase();
      if (arg === "next") this.state.page = (this.state.page || 1) + 1;
      else if (arg === "prev") this.state.page = Math.max(1, (this.state.page || 1) - 1);
      else {
        const page = Number.parseInt(arg, 10);
        this.state.page = Number.isNaN(page) ? 1 : Math.max(1, page);
      }
      saveShellState(this.cortexPath, this.state);
      this.setMessage(`Page ${this.state.page}`);
      return;
    }

    if (command === "per-page") {
      const n = Number.parseInt(parts[1] || "", 10);
      if (Number.isNaN(n) || n < 1 || n > 200) {
        this.setMessage("Usage: :per-page <1..200>");
        return;
      }
      this.state.perPage = n;
      this.state.page = 1;
      saveShellState(this.cortexPath, this.state);
      this.setMessage(`Rows per page set to ${n}.`);
      return;
    }

    this.setMessage(`Unknown command: ${trimmed}`);
  }

  async handleInput(raw: string): Promise<boolean> {
    const input = raw.trim();
    if (this.pendingConfirm) {
      const pending = this.pendingConfirm;
      this.pendingConfirm = undefined;
      if (input.toLowerCase() === "y") {
        pending.action();
      } else {
        this.setMessage("Cancelled.");
      }
      return true;
    }
    if (this.showHelp) {
      this.showHelp = false;
      this.setMessage(`Type ${style.boldCyan(":help")} for keyboard map and palette commands.`);
      if (!input) return true;
    }
    if (!input) return true;

    if (["q", "quit", ":q", ":quit", ":exit"].includes(input.toLowerCase())) {
      return false;
    }

    if (input === "p") {
      this.setView("Projects");
      this.setMessage("Projects view.");
      return true;
    }
    if (input === "b") {
      this.setView("Backlog");
      this.setMessage("Backlog view.");
      return true;
    }
    if (input === "l") {
      this.setView("Learnings");
      this.setMessage("Learnings view.");
      return true;
    }
    if (input === "m") {
      this.setView("Memory Queue");
      this.setMessage("Memory Queue view.");
      return true;
    }
    if (input === "h") {
      this.setView("Health");
      this.healthCache = undefined;
      this.setMessage("Health view.");
      return true;
    }

    if (input.startsWith("/")) {
      this.setFilter(input.slice(1));
      return true;
    }

    if (input.startsWith(":")) {
      await this.executePalette(input.slice(1));
      return true;
    }

    await this.executePalette(input);
    return true;
  }
}

function clearScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\u001Bc");
  }
}

export async function startShell(cortexPath: string, profile: string): Promise<void> {
  const shell = new CortexShell(cortexPath, profile);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const repaint = async () => {
    clearScreen();
    process.stdout.write(await shell.render());
    rl.setPrompt(`\n${style.boldCyan(":cortex>")} `);
    rl.prompt();
  };

  await repaint();

  rl.on("line", async (line) => {
    try {
      const keepRunning = await shell.handleInput(line);
      if (!keepRunning) {
        shell.close();
        rl.close();
        return;
      }
    } catch (err: any) {
      process.stdout.write(`\n${style.red("Error:")} ${String(err?.message || err)}\n`);
    }

    await repaint();
  });

  rl.on("SIGINT", () => {
    shell.close();
    rl.close();
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      shell.close();
      resolve();
    });
  });
}

export function shellStatePath(cortexPath: string): string {
  return path.join(cortexPath, ".governance", "shell-state.json");
}

export function shellStateExists(cortexPath: string): boolean {
  return fs.existsSync(shellStatePath(cortexPath));
}
