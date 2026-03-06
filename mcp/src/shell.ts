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
  return [
    "Shortcuts: p=projects b=backlog l=learnings m=memory h=health q=quit /=filter :palette",
    "Palette commands:",
    "  :open <project>                              select active project context",
    "  :add <task>                                  add backlog item to queue",
    "  :complete <task-id|match>                    mark backlog item done",
    "  :move <task-id|match> <active|queue|done>    move backlog item",
    "  :reprioritize <task-id|match> <high|medium|low>",
    "  :context <task-id|match> <text>              append/update context",
    "  :work next                                   move top queue item to active",
    "  :tidy [keep]                                 archive done items (default keep=30)",
    "  :learn add <text>                            append learning",
    "  :learn remove <learning-id|match>            remove learning",
    "  :mq approve|reject <queue-id|match>          memory queue triage",
    "  :mq edit <queue-id|match> <text>             edit memory queue item",
    "  :machine map <hostname> <profile>            safely edit machines.yaml",
    "  :profile add-project <profile> <project>     safely edit profile projects",
    "  :profile remove-project <profile> <project>",
    "  :run fix                                     run doctor --fix",
    "  :relink                                      rerun cortex link",
    "  :rerun hooks                                 run lifecycle hooks now",
    "  :update                                      update cortex to latest",
    "  :reset                                       reset shell state",
    "  :page next|prev|<n>                          change pagination",
    "  :per-page <n>                                set rows per page",
    "  :help                                        show this help",
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
    register: true,
    allTools: true,
  });
  return "Relink completed for detected tools.";
}

export class CortexShell {
  private state: ShellState;
  private message = "Type :help for keyboard map and palette commands.";
  private healthCache?: { at: number; result: DoctorResultLike };

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
  }

  close(): void {
    saveShellState(this.cortexPath, this.state);
  }

  private setMessage(msg: string): void {
    this.message = msg;
  }

  private setView(view: ShellView): void {
    this.state.view = view;
    this.state.page = 1;
    saveShellState(this.cortexPath, this.state);
  }

  private selectedProject(): string | null {
    if (!this.state.project) return null;
    return this.state.project;
  }

  private ensureProjectSelected(): string | null {
    const selected = this.selectedProject();
    if (!selected) {
      this.setMessage("Select a project first with :open <project> or from Projects view.");
      return null;
    }
    return selected;
  }

  private renderHeader(): string[] {
    return [
      "cortex shell",
      `Path: ${this.cortexPath}`,
      `View: ${this.state.view} | Project: ${this.state.project || "(none)"} | Filter: ${this.state.filter || "(none)"}`,
      "Keys: p b l m h q / :",
      "",
    ];
  }

  private renderProjectsView(): string[] {
    const lines: string[] = ["[Projects]", ""];    
    const cards = listProjectCards(this.cortexPath, this.profile);
    if (!cards.length) {
      lines.push("No indexed projects in this profile.");
      return lines;
    }

    const filtered = this.state.filter
      ? cards.filter((card) => `${card.name} ${card.summary} ${card.docs.join(" ")}`.toLowerCase().includes(this.state.filter!.toLowerCase()))
      : cards;

    if (!filtered.length) {
      lines.push("No projects matched current filter.");
      return lines;
    }

    for (const card of filtered) {
      const marker = card.name === this.state.project ? "*" : " ";
      lines.push(`${marker} ${card.name}  [${card.docs.join(" | ") || "no docs"}]`);
      if (card.summary) lines.push(`    ${card.summary}`);
    }

    lines.push("", "Use :open <project> to pin context across all views.");
    return lines;
  }

  private renderBacklogSection(title: string, items: BacklogItem[]): string[] {
    const lines: string[] = [`${title}:`];
    if (!items.length) {
      lines.push("  (empty)");
      return lines;
    }

    const filtered = this.state.filter ? backlogsByFilter(items, this.state.filter) : items;
    if (!filtered.length) {
      lines.push("  (no matches under current filter)");
      return lines;
    }

    const { pageItems, totalPages } = perPageSlice(filtered, this.state.page || 1, this.state.perPage || 40);
    for (const item of pageItems) {
      lines.push(`  ${item.id} ${item.checked ? "[x]" : "[ ]"} ${item.line}`);
      if (item.context) lines.push(`    Context: ${item.context}`);
    }
    if (totalPages > 1) {
      lines.push(`  Page ${Math.min(this.state.page || 1, totalPages)} / ${totalPages}`);
    }
    return lines;
  }

  private renderBacklogView(): string[] {
    const lines: string[] = ["[Backlog]", ""];
    const project = this.selectedProject();
    if (!project) {
      lines.push("No selected project. Use :open <project>.");
      return lines;
    }

    const parsed = readBacklog(this.cortexPath, project);
    if (typeof parsed === "string") {
      lines.push(parsed);
      return lines;
    }

    if (parsed.issues.length) {
      lines.push(`Warnings: ${parsed.issues.join("; ")}`, "");
    }

    lines.push(...this.renderBacklogSection("Active", parsed.items.Active), "");
    lines.push(...this.renderBacklogSection("Queue", parsed.items.Queue), "");
    lines.push(...this.renderBacklogSection("Done", parsed.items.Done));
    return lines;
  }

  private renderLearningsView(): string[] {
    const lines: string[] = ["[Learnings]", ""];
    const project = this.selectedProject();
    if (!project) {
      lines.push("No selected project. Use :open <project>.");
      return lines;
    }

    const learnings = readLearnings(this.cortexPath, project);
    if (typeof learnings === "string") {
      lines.push(learnings);
      return lines;
    }

    if (!learnings.length) {
      lines.push("No learning entries yet.");
      return lines;
    }

    const filtered = this.state.filter
      ? learnings.filter((item) => `${item.id} ${item.date} ${item.text}`.toLowerCase().includes(this.state.filter!.toLowerCase()))
      : learnings;

    const { pageItems, totalPages } = perPageSlice(filtered, this.state.page || 1, this.state.perPage || 40);
    for (const item of pageItems) {
      lines.push(`${item.id} [${item.date}] ${item.text}`);
      if (item.citation) lines.push(`  citation: ${item.citation}`);
    }
    if (totalPages > 1) {
      lines.push(``, `Page ${Math.min(this.state.page || 1, totalPages)} / ${totalPages}`);
    }
    lines.push("", "Write with :learn add <text>, remove with :learn remove <id|match>");
    return lines;
  }

  private renderMemoryQueueView(): string[] {
    const lines: string[] = ["[Memory Queue]", ""];
    const project = this.selectedProject();
    if (!project) {
      lines.push("No selected project. Use :open <project>.");
      return lines;
    }

    const items = readMemoryQueue(this.cortexPath, project);
    if (typeof items === "string") {
      lines.push(items);
      return lines;
    }

    if (!items.length) {
      lines.push("No queued memory items.");
      return lines;
    }

    const filtered = this.state.filter ? queueByFilter(items, this.state.filter) : items;
    const { pageItems, totalPages } = perPageSlice(filtered, this.state.page || 1, this.state.perPage || 40);
    for (const item of pageItems) {
      const risk = item.risky ? "risk" : "ok";
      const conf = item.confidence !== undefined ? ` conf=${item.confidence.toFixed(2)}` : "";
      lines.push(`${item.id} [${item.section}] [${risk}] [${item.date}]${conf}`);
      lines.push(`  ${item.text}`);
    }
    if (totalPages > 1) {
      lines.push(``, `Page ${Math.min(this.state.page || 1, totalPages)} / ${totalPages}`);
    }
    lines.push("", "Actions: :mq approve <id> | :mq reject <id> | :mq edit <id> <text>");
    return lines;
  }

  private renderMachinesView(): string[] {
    const lines: string[] = ["[Machines/Profiles]", ""];
    const machines = listMachines(this.cortexPath);
    const profiles = listProfiles(this.cortexPath);

    lines.push("Machines:");
    if (typeof machines === "string") {
      lines.push(`  ${machines}`);
    } else {
      const entries = Object.entries(machines);
      if (!entries.length) lines.push("  (none)");
      for (const [machine, profile] of entries) lines.push(`  ${machine} -> ${profile}`);
    }

    lines.push("", "Profiles:");
    if (typeof profiles === "string") {
      lines.push(`  ${profiles}`);
    } else {
      if (!profiles.length) lines.push("  (none)");
      for (const profile of profiles) {
        lines.push(`  ${profile.name}: ${profile.projects.join(", ") || "(no projects)"}`);
      }
    }

    lines.push(
      "",
      "Safe edit flow:",
      "  :machine map <hostname> <profile>",
      "  :profile add-project <profile> <project>",
      "  :profile remove-project <profile> <project>"
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
    const lines: string[] = ["[Health]", ""];
    const doctor = await this.doctorSnapshot();
    const runtime = readRuntimeHealth(this.cortexPath);

    lines.push(`Doctor: ${doctor.ok ? "ok" : "issues found"}`);
    if (doctor.machine) lines.push(`Machine: ${doctor.machine}`);
    if (doctor.profile) lines.push(`Profile: ${doctor.profile}`);

    lines.push("", "Checks:");
    for (const check of doctor.checks) {
      lines.push(`  - ${check.ok ? "ok" : "fail"} ${check.name}: ${check.detail}`);
    }

    lines.push("", "Runtime:");
    lines.push(`  last hook run: ${runtime.lastPromptAt || "n/a"}`);
    lines.push(`  last auto-save: ${runtime.lastAutoSave?.at || "n/a"} (${runtime.lastAutoSave?.status || "n/a"})`);
    lines.push(`  last governance: ${runtime.lastGovernance?.at || "n/a"} (${runtime.lastGovernance?.status || "n/a"})`);

    lines.push("", "Remediation commands:");
    lines.push("  :run fix      (doctor --fix)");
    lines.push("  :relink       (rebuild links/hooks)");
    lines.push("  :rerun hooks  (session-start + stop)");
    lines.push("  :update       (install latest cortex)");

    return lines;
  }

  async render(): Promise<string> {
    const lines = this.renderHeader();
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

    lines.push("", `Status: ${this.message}`);
    lines.push("Type :help for command palette.");
    return lines.join("\n") + "\n";
  }

  private setFilter(value: string): void {
    this.state.filter = value.trim() || undefined;
    this.state.page = 1;
    saveShellState(this.cortexPath, this.state);
    this.setMessage(this.state.filter ? `Filter set to: ${this.state.filter}` : "Filter cleared.");
  }

  private resolveMatchToken(token: string): string {
    return token.trim();
  }

  private async executePalette(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) return;
    const parts = tokenize(trimmed);
    const command = (parts[0] || "").toLowerCase();

    if (command === "help") {
      this.setMessage(shellHelpText());
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
      const match = this.resolveMatchToken(parts.slice(1).join(" "));
      if (!match) {
        this.setMessage("Usage: :complete <task-id|match>");
        return;
      }
      this.setMessage(completeBacklogItem(this.cortexPath, project, match));
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
      const context = trimmed.slice(trimmed.indexOf(match) + match.length).trim();
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
        this.setMessage(removeLearning(this.cortexPath, project, match));
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
        this.setMessage(rejectMemoryQueueItem(this.cortexPath, project, match));
        return;
      }
      if (action === "edit") {
        if (parts.length < 4) {
          this.setMessage("Usage: :mq edit <queue-id|match> <text>");
          return;
        }
        const match = parts[2];
        const text = trimmed.slice(trimmed.indexOf(match) + match.length).trim();
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
      const doctor = await this.deps.runDoctor(this.cortexPath, true);
      this.healthCache = undefined;
      this.setMessage(`doctor --fix completed: ${doctor.ok ? "ok" : "issues remain"}`);
      return;
    }

    if (command === "relink") {
      this.setMessage(await this.deps.runRelink(this.cortexPath));
      return;
    }

    if (command === "rerun" && parts[1]?.toLowerCase() === "hooks") {
      this.setMessage(await this.deps.runHooks(this.cortexPath));
      this.healthCache = undefined;
      return;
    }

    if (command === "update") {
      this.setMessage(await this.deps.runUpdate());
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
    rl.setPrompt("\n:cortex> ");
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
      process.stdout.write(`\nError: ${String(err?.message || err)}\n`);
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
