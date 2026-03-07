/**
 * Command palette and input handling for the cortex interactive shell.
 * Extracted from shell.ts to keep the orchestrator under 300 lines.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  addBacklogItem,
  addFinding,
  addProjectToProfile,
  approveQueueItem,
  BacklogItem,
  completeBacklogItem,
  editQueueItem,
  listProjectCards,
  pinBacklogItem,
  readBacklog,
  readFindings,
  readReviewQueue,
  rejectQueueItem,
  removeFinding,
  removeProjectFromProfile,
  resetShellState,
  saveShellState,
  setMachineProfile,
  ShellState,
  tidyBacklogDone,
  unpinBacklogItem,
  updateBacklogItem,
  workNextBacklogItem,
  loadShellState,
} from "./data-access.js";
import { style } from "./shell-render.js";
import { SUB_VIEWS, TAB_ICONS, type ShellDeps, type ShellView } from "./shell-types.js";
import {
  resultMsg,
  editDistance,
  tokenize,
  expandIds,
  normalizeSection,
  resolveEntryScript,
  backlogsByFilter,
  queueByFilter,
} from "./shell-palette.js";

/** Interface for the shell methods that executePalette needs */
export interface PaletteHost {
  cortexPath: string;
  profile: string;
  state: ShellState;
  deps: ShellDeps;
  showHelp: boolean;
  healthCache: { at: number; result: any } | undefined;
  setMessage(msg: string): void;
  setView(view: ShellState["view"]): void;
  confirmThen(label: string, action: () => void): void;
  snapshotForUndo(label: string, file: string): void;
  ensureProjectSelected(): string | null;
  invalidateSubsectionsCache(): void;
  popUndo(): string;
}

/** Extended host interface for navigation and view-action methods */
export interface NavigationHost extends PaletteHost {
  currentCursor(): number;
  setCursor(n: number): void;
  moveCursor(delta: number): void;
  getListItems(): { id?: string; name?: string; text?: string; line?: string }[];
  startInput(ctx: string, initial: string): void;
  inputMqId: string;
  prevHealthView: ShellView | undefined;
  filter: string | undefined;
  setFilter(value: string): void;
}

export async function executePalette(host: PaletteHost, input: string): Promise<void> {
  const trimmed = input.trim();
  if (!trimmed) return;
  const parts = tokenize(trimmed);
  const command = (parts[0] || "").toLowerCase();

  if (command === "help") {
    host.showHelp = true;
    host.setMessage("  Showing help — press any key to dismiss");
    return;
  }

  if (command === "projects") { host.setView("Projects"); host.setMessage(`  ${TAB_ICONS.Projects} Projects`); return; }
  if (command === "backlog") { host.setView("Backlog"); host.setMessage(`  ${TAB_ICONS.Backlog} Backlog`); return; }
  if (command === "learnings" || command === "findings") { host.setView("Findings"); host.setMessage(`  ${TAB_ICONS.Findings} Findings`); return; }
  if (command === "memory") { host.setView("Review Queue"); host.setMessage(`  ${TAB_ICONS["Review Queue"]} Review Queue`); return; }
  if (command === "machines") { host.setView("Machines/Profiles"); host.setMessage("  Machines/Profiles"); return; }
  if (command === "health") {
    host.healthCache = undefined;
    host.setView("Health");
    host.setMessage(`  ${TAB_ICONS.Health} Health`);
    return;
  }

  if (command === "open") {
    const project = parts[1];
    if (!project) { host.setMessage("  Usage: :open <project>"); return; }
    const cards = listProjectCards(host.cortexPath, host.profile);
    if (!cards.some((c) => c.name === project)) { host.setMessage(`  Unknown project: ${project}`); return; }
    host.state.project = project;
    saveShellState(host.cortexPath, host.state);
    host.setMessage(`  ${style.green("●")} ${style.boldCyan(project)} — project context set`);
    return;
  }

  if (command === "search") {
    const query = trimmed.slice("search".length).trim();
    if (!query) { host.setMessage("  Usage: :search <query>"); return; }
    host.setMessage("  Searching…");
    try {
      const entry = resolveEntryScript();
      const args = [entry, "search", query, "--limit", "6"];
      if (host.state.project) args.push("--project", host.state.project);
      const out = execFileSync(process.execPath, args, {
        cwd: host.cortexPath, encoding: "utf8", timeout: 60_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      host.setMessage(out.split("\n").slice(0, 14).join("\n") || "  No results.");
    } catch (err: unknown) {
      host.setMessage(`  Search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (command === "add") {
    const project = host.ensureProjectSelected();
    if (!project) return;
    const text = trimmed.slice("add".length).trim();
    if (!text) { host.setMessage("  Usage: :add <task>"); return; }
    host.setMessage(`  ${resultMsg(addBacklogItem(host.cortexPath, project, text))}`);
    return;
  }

  if (command === "complete") {
    const project = host.ensureProjectSelected();
    if (!project) return;
    const match = parts.slice(1).join(" ").trim();
    if (!match) { host.setMessage("  Usage: :complete <id|match>"); return; }
    const ids = expandIds(match);
    if (ids.length > 1) {
      host.confirmThen(`Complete ${ids.length} items (${ids.join(", ")})?`, () => {
        const file = path.join(host.cortexPath, project, "backlog.md");
        host.snapshotForUndo(`complete ${ids.length} items`, file);
        host.setMessage(ids.map((id) => resultMsg(completeBacklogItem(host.cortexPath, project, id))).join("; "));
      });
    } else {
      host.confirmThen(`Complete "${match}"?`, () => {
        const file = path.join(host.cortexPath, project, "backlog.md");
        host.snapshotForUndo(`complete "${match}"`, file);
        host.setMessage(`  ${resultMsg(completeBacklogItem(host.cortexPath, project, match))}`);
      });
    }
    return;
  }

  if (command === "move") {
    const project = host.ensureProjectSelected();
    if (!project) return;
    if (parts.length < 3) { host.setMessage("  Usage: :move <id|match> <active|queue|done>"); return; }
    const section = normalizeSection(parts[parts.length - 1]);
    if (!section) { host.setMessage("  Target section must be active|queue|done"); return; }
    const match = parts.slice(1, -1).join(" ");
    const ids = expandIds(match);
    if (ids.length > 1) {
      const file = path.join(host.cortexPath, project, "backlog.md");
      host.snapshotForUndo(`move ${ids.length} items to ${section}`, file);
      host.setMessage(ids.map((id) => resultMsg(updateBacklogItem(host.cortexPath, project, id, { section }))).join("; "));
    } else {
      host.setMessage(`  ${resultMsg(updateBacklogItem(host.cortexPath, project, match, { section }))}`);
    }
    return;
  }

  if (command === "reprioritize") {
    const project = host.ensureProjectSelected();
    if (!project) return;
    if (parts.length < 3) { host.setMessage("  Usage: :reprioritize <id|match> <high|medium|low>"); return; }
    const priority = parts[parts.length - 1].toLowerCase();
    if (!["high", "medium", "low"].includes(priority)) { host.setMessage("  Priority must be high|medium|low"); return; }
    const match = parts.slice(1, -1).join(" ");
    host.setMessage(`  ${resultMsg(updateBacklogItem(host.cortexPath, project, match, { priority }))}`);
    return;
  }

  if (command === "context") {
    const project = host.ensureProjectSelected();
    if (!project) return;
    if (parts.length < 3) { host.setMessage("  Usage: :context <id|match> <text>"); return; }
    const match = parts[1];
    const context = parts.slice(2).join(" ");
    host.setMessage(`  ${resultMsg(updateBacklogItem(host.cortexPath, project, match, { context }))}`);
    return;
  }

  if (command === "pin") {
    const project = host.ensureProjectSelected();
    if (!project) return;
    if (parts.length < 2) { host.setMessage("  Usage: :pin <id|match>"); return; }
    host.setMessage(`  ${resultMsg(pinBacklogItem(host.cortexPath, project, parts.slice(1).join(" ")))}`);
    return;
  }

  if (command === "unpin") {
    const project = host.ensureProjectSelected();
    if (!project) return;
    if (parts.length < 2) { host.setMessage("  Usage: :unpin <id|match>"); return; }
    host.setMessage(`  ${resultMsg(unpinBacklogItem(host.cortexPath, project, parts.slice(1).join(" ")))}`);
    return;
  }

  if (command === "work" && parts[1]?.toLowerCase() === "next") {
    const project = host.ensureProjectSelected();
    if (!project) return;
    host.setMessage(`  ${resultMsg(workNextBacklogItem(host.cortexPath, project))}`);
    return;
  }

  if (command === "tidy") {
    const project = host.ensureProjectSelected();
    if (!project) return;
    const keep = parts[1] ? Number.parseInt(parts[1], 10) : 30;
    const file = path.join(host.cortexPath, project, "backlog.md");
    host.snapshotForUndo("tidy", file);
    host.setMessage(`  ${resultMsg(tidyBacklogDone(host.cortexPath, project, Number.isNaN(keep) ? 30 : keep))}`);
    return;
  }

  if (command === "learn" || command === "find") {
    const project = host.ensureProjectSelected();
    if (!project) return;
    const action = (parts[1] || "").toLowerCase();
    if (action === "add") {
      const text = trimmed.split(/\s+/).slice(2).join(" ").trim();
      if (!text) { host.setMessage("  Usage: :find add <text>"); return; }
      host.setMessage(`  ${resultMsg(addFinding(host.cortexPath, project, text))}`);
      return;
    }
    if (action === "remove") {
      const match = parts.slice(2).join(" ").trim();
      if (!match) { host.setMessage("  Usage: :find remove <id|match>"); return; }
      host.confirmThen(`Remove finding "${match}"?`, () => {
        const file = path.join(host.cortexPath, project!, "FINDINGS.md");
        host.snapshotForUndo(`find remove "${match}"`, file);
        host.setMessage(`  ${resultMsg(removeFinding(host.cortexPath, project!, match))}`);
      });
      return;
    }
    host.setMessage("  Usage: :find add <text> | :find remove <id|match>");
    return;
  }

  if (command === "mq") {
    const project = host.ensureProjectSelected();
    if (!project) return;
    const action = (parts[1] || "").toLowerCase();
    if (action === "approve") {
      const match = parts.slice(2).join(" ").trim();
      if (!match) { host.setMessage("  Usage: :mq approve <id|match>"); return; }
      const ids = expandIds(match);
      host.setMessage(
        ids.length > 1
          ? ids.map((id) => resultMsg(approveQueueItem(host.cortexPath, project, id))).join("; ")
          : `  ${resultMsg(approveQueueItem(host.cortexPath, project, match))}`,
      );
      return;
    }
    if (action === "reject") {
      const match = parts.slice(2).join(" ").trim();
      if (!match) { host.setMessage("  Usage: :mq reject <id|match>"); return; }
      const ids = expandIds(match);
      if (ids.length > 1) {
        host.confirmThen(`Reject ${ids.length} items (${ids.join(", ")})?`, () => {
          const file = path.join(host.cortexPath, project!, "MEMORY_QUEUE.md");
          host.snapshotForUndo(`mq reject ${ids.length} items`, file);
          host.setMessage(ids.map((id) => resultMsg(rejectQueueItem(host.cortexPath, project!, id))).join("; "));
        });
      } else {
        host.confirmThen(`Reject "${match}"?`, () => {
          const file = path.join(host.cortexPath, project!, "MEMORY_QUEUE.md");
          host.snapshotForUndo(`mq reject "${match}"`, file);
          host.setMessage(`  ${resultMsg(rejectQueueItem(host.cortexPath, project!, match))}`);
        });
      }
      return;
    }
    if (action === "edit") {
      if (parts.length < 4) { host.setMessage("  Usage: :mq edit <id|match> <text>"); return; }
      host.setMessage(`  ${resultMsg(editQueueItem(host.cortexPath, project, parts[2], parts.slice(3).join(" ")))}`);
      return;
    }
    host.setMessage("  Usage: :mq approve|reject|edit ...");
    return;
  }

  if (command === "machine" && parts[1]?.toLowerCase() === "map") {
    if (parts.length < 4) { host.setMessage("  Usage: :machine map <hostname> <profile>"); return; }
    host.setMessage(`  ${resultMsg(setMachineProfile(host.cortexPath, parts[2], parts[3]))}`);
    return;
  }

  if (command === "profile") {
    const action = (parts[1] || "").toLowerCase();
    const profileName = parts[2];
    const project = parts[3];
    if (!profileName || !project) { host.setMessage("  Usage: :profile add-project|remove-project <profile> <project>"); return; }
    if (action === "add-project") {
      host.setMessage(`  ${resultMsg(addProjectToProfile(host.cortexPath, profileName, project))}`);
      return;
    }
    if (action === "remove-project") {
      host.setMessage(`  ${resultMsg(removeProjectFromProfile(host.cortexPath, profileName, project))}`);
      return;
    }
    host.setMessage("  Usage: :profile add-project|remove-project <profile> <project>");
    return;
  }

  if (command === "run" && parts[1]?.toLowerCase() === "fix") {
    const t0 = Date.now();
    const doctor = await host.deps.runDoctor(host.cortexPath, true);
    host.healthCache = undefined;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    host.setMessage(`  doctor --fix: ${doctor.ok ? style.green("ok") : style.red("issues remain")} (${elapsed}s)`);
    return;
  }

  if (command === "relink") {
    const t0 = Date.now();
    const r = await host.deps.runRelink(host.cortexPath);
    host.setMessage(`  ${r} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return;
  }

  if (command === "rerun" && parts[1]?.toLowerCase() === "hooks") {
    const t0 = Date.now();
    const r = await host.deps.runHooks(host.cortexPath);
    host.healthCache = undefined;
    host.setMessage(`  ${r} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return;
  }

  if (command === "update") {
    const t0 = Date.now();
    const r = await host.deps.runUpdate();
    host.setMessage(`  ${r} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return;
  }

  if (command === "govern") {
    const project = host.ensureProjectSelected();
    if (!project) return;
    try {
      const t0 = Date.now();
      const out = execFileSync(process.execPath, [resolveEntryScript(), "govern-memories", project], {
        cwd: host.cortexPath, encoding: "utf8", timeout: 60_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      host.setMessage(`  ${out || "Governance scan completed."} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err: unknown) {
      host.setMessage(`  Governance failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (command === "consolidate") {
    const project = host.ensureProjectSelected();
    if (!project) return;
    try {
      const t0 = Date.now();
      const out = execFileSync(process.execPath, [resolveEntryScript(), "consolidate-memories", project], {
        cwd: host.cortexPath, encoding: "utf8", timeout: 60_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      host.setMessage(`  ${out || "Consolidation completed."} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err: unknown) {
      host.setMessage(`  Consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (command === "conflicts") {
    try {
      const lines: string[] = [];
      try {
        const conflicted = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
          cwd: host.cortexPath, encoding: "utf8", timeout: 10_000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (conflicted) {
          lines.push(style.boldRed("  Unresolved conflicts:"));
          for (const f of conflicted.split("\n").filter(Boolean)) {
            lines.push(`    ${style.red("!")} ${f}`);
          }
        }
      } catch { /* not a git repo */ }

      const auditPath = path.join(host.cortexPath, ".governance", "audit.log");
      if (fs.existsSync(auditPath)) {
        const auditLines = fs.readFileSync(auditPath, "utf8").split("\n")
          .filter((l) => l.includes("auto_merge"))
          .slice(-10);
        if (auditLines.length) {
          lines.push(`  ${style.bold("Recent auto-merges:")}`);
          for (const l of auditLines) lines.push(`    ${style.dim(l)}`);
        }
      }

      const project = host.state.project;
      if (project) {
        const queueResult = readReviewQueue(host.cortexPath, project);
        if (queueResult.ok) {
          const conflictItems = queueResult.data.filter((q) => q.section === "Conflicts");
          if (conflictItems.length) {
            lines.push(`  ${style.yellow(`${conflictItems.length} conflict(s) in Memory Queue`)}  (:mq approve|reject)`);
          }
        }
      }

      host.setMessage(lines.length ? lines.join("\n") : "  No conflicts found.");
    } catch (err: unknown) {
      host.setMessage(`  Conflict check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (command === "undo") {
    host.setMessage(`  ${host.popUndo()}`);
    return;
  }

  if (command === "diff") {
    const project = host.ensureProjectSelected();
    if (!project) return;
    try {
      const projectDir = path.join(host.cortexPath, project);
      const diff = execFileSync("git", ["diff", "--no-color", "--", projectDir], {
        cwd: host.cortexPath, encoding: "utf8", timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!diff) {
        const staged = execFileSync("git", ["diff", "--cached", "--no-color", "--", projectDir], {
          cwd: host.cortexPath, encoding: "utf8", timeout: 10_000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        host.setMessage(staged || "  No uncommitted changes.");
      } else {
        const lines = diff.split("\n").slice(0, 30);
        if (diff.split("\n").length > 30) lines.push(style.dim(`... (${diff.split("\n").length - 30} more lines)`));
        host.setMessage(lines.join("\n"));
      }
    } catch {
      host.setMessage("  Not a git repository or git not available.");
    }
    return;
  }

  if (command === "reset") {
    host.setMessage(`  ${resultMsg(resetShellState(host.cortexPath))}`);
    const newState = loadShellState(host.cortexPath);
    Object.assign(host.state, newState);
    const cards = listProjectCards(host.cortexPath, host.profile);
    host.state.project = cards[0]?.name;
    return;
  }

  const suggestion = suggestCommand(command);
  if (suggestion) {
    host.setMessage(`  Unknown: ${trimmed} — did you mean :${suggestion}?`);
  } else {
    host.setMessage(`  Unknown: ${trimmed} — press ${style.boldCyan("?")} for help`);
  }
}

export function suggestCommand(input: string): string | undefined {
  const known = [
    "help", "projects", "backlog", "learnings", "memory", "machines", "health",
    "open", "search", "add", "complete", "move", "reprioritize", "pin", "unpin", "context",
    "work next", "tidy", "learn add", "learn remove", "mq approve", "mq reject",
    "mq edit", "machine map", "profile add-project", "profile remove-project",
    "run fix", "relink", "rerun hooks", "update", "govern", "consolidate",
    "undo", "diff", "conflicts", "reset",
  ];
  let best: string | undefined;
  let bestDist = Infinity;
  for (const cmd of known) {
    const d = editDistance(input.toLowerCase(), cmd);
    if (d < bestDist && d <= 2) { bestDist = d; best = cmd; }
  }
  return best;
}

export function completeInput(line: string, cortexPath: string, profile: string, state: ShellState): string[] {
  const commands = [
    ":projects", ":backlog", ":learnings", ":findings", ":memory", ":machines", ":health",
    ":open", ":search", ":add", ":complete", ":move", ":reprioritize", ":pin",
    ":unpin", ":context", ":work next", ":tidy", ":find add", ":find remove",
    ":mq approve", ":mq reject", ":mq edit", ":machine map",
    ":profile add-project", ":profile remove-project",
    ":run fix", ":relink", ":rerun hooks", ":update", ":govern", ":consolidate",
    ":undo", ":diff", ":conflicts", ":reset", ":help",
  ];

  const trimmed = line.trimStart();
  if (!trimmed.startsWith(":")) return [];
  const after = trimmed.slice(1);
  const parts = tokenize(after);
  const endsWithSpace = /\s$/.test(trimmed);

  if (parts.length === 0) return commands;
  if (parts.length === 1 && !endsWithSpace) {
    const prefix = `:${parts[0].toLowerCase()}`;
    return commands.filter((c) => c.startsWith(prefix));
  }

  const cmd = parts[0].toLowerCase();
  if (cmd === "open") {
    return listProjectCards(cortexPath, profile).map((c) => `:open ${c.name}`);
  }

  if (["complete", "move", "reprioritize", "context", "pin", "unpin"].includes(cmd)) {
    const project = state.project;
    if (!project) return [];
    const result = readBacklog(cortexPath, project);
    if (!result.ok) return [];
    return [
      ...result.data.items.Active,
      ...result.data.items.Queue,
      ...result.data.items.Done,
    ].map((item) => `:${cmd} ${item.id}`);
  }

  if (cmd === "mq" && ["approve", "reject", "edit"].includes((parts[1] || "").toLowerCase())) {
    const project = state.project;
    if (!project) return [];
    const result = readReviewQueue(cortexPath, project);
    if (!result.ok) return [];
    return result.data.map((item) => `:mq ${parts[1].toLowerCase()} ${item.id}`);
  }

  if (cmd === "find" && (parts[1] || "").toLowerCase() === "remove") {
    const project = state.project;
    if (!project) return [];
    const r = readFindings(cortexPath, project);
    if (!r.ok) return [];
    return r.data.map((item) => `:find remove ${item.id}`);
  }

  return commands;
}

// ── List items for each view ──────────────────────────────────────────────────

export function getListItems(
  cortexPath: string, profile: string, state: ShellState, healthLineCount: number,
): { id?: string; name?: string; text?: string; line?: string }[] {
  switch (state.view) {
    case "Projects": {
      const cards = listProjectCards(cortexPath, profile);
      return state.filter
        ? cards.filter((c) => `${c.name} ${c.summary} ${c.docs.join(" ")}`.toLowerCase().includes(state.filter!.toLowerCase()))
        : cards;
    }
    case "Backlog": {
      if (!state.project) return [];
      const result = readBacklog(cortexPath, state.project);
      if (!result.ok) return [];
      const active = state.filter ? backlogsByFilter(result.data.items.Active, state.filter) : result.data.items.Active;
      const queue = state.filter ? backlogsByFilter(result.data.items.Queue, state.filter) : result.data.items.Queue;
      return [...active, ...queue];
    }
    case "Findings": {
      if (!state.project) return [];
      const result = readFindings(cortexPath, state.project);
      if (!result.ok) return [];
      return state.filter
        ? result.data.filter((i) => `${i.id} ${i.date} ${i.text}`.toLowerCase().includes(state.filter!.toLowerCase()))
        : result.data;
    }
    case "Review Queue": {
      if (!state.project) return [];
      const result = readReviewQueue(cortexPath, state.project);
      if (!result.ok) return [];
      return state.filter ? queueByFilter(result.data, state.filter) : result.data;
    }
    case "Health":
      return Array.from({ length: Math.max(1, healthLineCount) }, (_, i) => ({ id: String(i) }));
    default:
      return [];
  }
}

// ── Activation (Enter key) ────────────────────────────────────────────────────

export async function activateSelected(host: NavigationHost): Promise<void> {
  const cursor = host.currentCursor();
  const items = host.getListItems();
  const item = items[cursor];
  if (!item) return;

  switch (host.state.view) {
    case "Projects":
      if (item.name) { host.state.project = item.name; saveShellState(host.cortexPath, host.state); host.setView("Backlog"); host.setMessage(`  ${style.green("●")} ${style.boldCyan(item.name)}`); }
      break;
    case "Backlog":
      if (item.id) {
        const project = host.ensureProjectSelected();
        if (!project) return;
        const file = path.join(host.cortexPath, project, "backlog.md");
        host.confirmThen(`Complete ${style.dim(item.id)} "${item.line}"?`, () => {
          host.snapshotForUndo(`complete ${item.id}`, file);
          const r = completeBacklogItem(host.cortexPath, project, item.id!);
          host.invalidateSubsectionsCache();
          host.setMessage(`  ${resultMsg(r)}`);
          host.setCursor(Math.max(0, cursor - 1));
        });
      }
      break;
    case "Findings":
      if (item.text) { host.setMessage(`  ${style.dim(item.id ?? "")}  ${item.text}`); }
      break;
    case "Review Queue":
      if (item.text) { host.setMessage(`  ${style.dim(item.id ?? "")}  ${item.text}  ${style.dim("[ a approve · r reject ]")}`); }
      break;
  }
}

// ── View-specific action keys ─────────────────────────────────────────────────

export async function doViewAction(host: NavigationHost, key: string): Promise<void> {
  const cursor = host.currentCursor();
  const items = host.getListItems();
  const item = items[cursor];
  const project = host.state.project;

  switch (host.state.view) {
    case "Backlog":
      if (key === "a") { host.startInput("add", ""); }
      else if (key === "d" && item?.id) {
        if (!project) { host.setMessage("Select a project first."); return; }
        const file = path.join(host.cortexPath, project, "backlog.md");
        const backlogResult = readBacklog(host.cortexPath, project);
        const isActive = backlogResult.ok && backlogResult.data.items.Active.some((i: BacklogItem) => i.id === item.id);
        const targetSection = isActive ? "Queue" : "Active";
        host.snapshotForUndo(`move ${item.id} → ${targetSection.toLowerCase()}`, file);
        const r = updateBacklogItem(host.cortexPath, project, item.id, { section: targetSection });
        host.invalidateSubsectionsCache();
        host.setMessage(`  ${resultMsg(r)}`);
      }
      break;
    case "Findings":
      if (key === "a") { host.startInput("learn-add", ""); }
      else if ((key === "d" || key === "\x7f") && item?.text) {
        if (!project) { host.setMessage("Select a project first."); return; }
        host.confirmThen(`Delete finding ${style.dim(item.id ?? "")}?`, () => {
          const file = path.join(host.cortexPath, project!, "FINDINGS.md");
          host.snapshotForUndo(`remove finding ${item.id ?? ''}`, file);
          const r = removeFinding(host.cortexPath, project!, item.text!);
          host.setMessage(`  ${resultMsg(r)}`);
          host.setCursor(Math.max(0, cursor - 1));
        });
      }
      break;
    case "Review Queue":
      if (key === "a" && item?.id) {
        if (!project) { host.setMessage("Select a project first."); return; }
        host.confirmThen(`Approve ${style.dim(item.id)} "${item.text}"?`, () => {
          const r = approveQueueItem(host.cortexPath, project!, item.id!);
          host.setMessage(`  ${resultMsg(r)}`);
          host.setCursor(Math.max(0, cursor - 1));
        });
      } else if (key === "r" && item?.id) {
        if (!project) { host.setMessage("Select a project first."); return; }
        host.confirmThen(`Reject ${style.dim(item.id)} "${item.text}"?`, () => {
          const r = rejectQueueItem(host.cortexPath, project!, item.id!);
          host.setMessage(`  ${resultMsg(r)}`);
          host.setCursor(Math.max(0, cursor - 1));
        });
      } else if (key === "e" && item?.id) {
        host.startInput("mq-edit", item.text || "");
      }
      break;
  }
}

// ── Cursor position display ───────────────────────────────────────────────────

function showCursorPosition(host: NavigationHost): void {
  const items = host.getListItems();
  const count = items.length; if (count === 0) return;
  const cursor = host.currentCursor();
  const item = items[cursor];
  const label = item?.name ?? item?.line ?? item?.text ?? "";
  const short = label.length > 50 ? label.slice(0, 48) + "…" : label;
  host.setMessage(`  ${style.dim(`${cursor + 1} / ${count}`)}${short ? `  ${style.dimItalic(short)}` : ""}`);
}

// ── Navigate-mode key handler ─────────────────────────────────────────────────

export async function handleNavigateKey(host: NavigationHost, key: string): Promise<boolean> {
  if (key === "\x1b[A") { host.moveCursor(-1); showCursorPosition(host); return true; }
  if (key === "\x1b[B") { host.moveCursor(1); showCursorPosition(host); return true; }
  if (key === "\x1b[D") { if (host.state.view === "Projects") { host.setMessage(`  ${style.dim("press ↵ to open a project first")}`); } else { prevTab(host); } return true; }
  if (key === "\x1b[C") { if (host.state.view === "Projects") { host.setMessage(`  ${style.dim("press ↵ to open a project first")}`); } else { nextTab(host); } return true; }
  if (key === "\x1b[5~") { host.moveCursor(-10); showCursorPosition(host); return true; }
  if (key === "\x1b[6~") { host.moveCursor(10); showCursorPosition(host); return true; }
  if (key === "\x1b[H" || key === "\x1b[1~") { host.setCursor(0); showCursorPosition(host); return true; }
  if (key === "\x1b[F" || key === "\x1b[4~") { host.setCursor(host.getListItems().length - 1); showCursorPosition(host); return true; }
  if (key === "\t") { nextTab(host); return true; }
  if (key === "\x1b[Z") { prevTab(host); return true; }
  if (key === "q" || key === "Q") return false;
  if (key === "\r" || key === "\n") { await activateSelected(host); return true; }
  if (key === "?") { host.showHelp = !host.showHelp; host.setMessage(host.showHelp ? "  Showing help — press any key to dismiss" : `  ${style.boldCyan("←→")} ${style.dim("tabs")}  ${style.boldCyan("↑↓")} ${style.dim("move")}  ${style.boldCyan("↵")} ${style.dim("activate")}  ${style.boldCyan("?")} ${style.dim("help")}`); return true; }
  if (key === "/") { host.startInput("filter", host.filter || ""); return true; }
  if (key === ":") { host.startInput("command", ""); return true; }
  if (key === "\x1b") {
    if (host.filter) { host.setFilter(""); }
    else if (host.state.view === "Health") { const returnTo = host.prevHealthView ?? "Projects"; host.setView(returnTo); host.prevHealthView = undefined; host.setMessage(`  ${TAB_ICONS[returnTo] ?? TAB_ICONS.Projects} ${returnTo}`); }
    else if (host.state.view !== "Projects") { host.setView("Projects"); host.setMessage(`  ${TAB_ICONS.Projects} ${style.dim("select a project")}`); }
    else { host.setMessage(`  ${style.dim("press")} ${style.boldCyan("q")} ${style.dim("to quit")}`); }
    return true;
  }
  if (key === "p") { host.setView("Projects"); host.setMessage(`  ${TAB_ICONS.Projects} Projects`); return true; }
  if (key === "b") { if (!host.state.project) { host.setMessage(style.dim("  Select a project first (↵)")); return true; } host.setView("Backlog"); host.setMessage(`  ${TAB_ICONS.Backlog} Backlog`); return true; }
  if (key === "l") { if (!host.state.project) { host.setMessage(style.dim("  Select a project first (↵)")); return true; } host.setView("Findings"); host.setMessage(`  ${TAB_ICONS.Findings} Findings`); return true; }
  if (key === "m") { if (!host.state.project) { host.setMessage(style.dim("  Select a project first (↵)")); return true; } host.setView("Review Queue"); host.setMessage(`  ${TAB_ICONS["Review Queue"]} Review Queue`); return true; }
  if (key === "h") { host.prevHealthView = host.state.view === "Health" ? host.prevHealthView : host.state.view; host.healthCache = undefined; host.setView("Health"); host.setMessage(`  ${TAB_ICONS.Health} Health  ${style.dim("(esc to return)")}`); return true; }
  if (["a", "d", "r", "e", "\x7f"].includes(key)) { await doViewAction(host, key); return true; }
  return true;
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function nextTab(host: NavigationHost): void {
  if (host.state.view === "Projects" || host.state.view === "Health") return;
  const idx = SUB_VIEWS.indexOf(host.state.view as typeof SUB_VIEWS[number]);
  const next = SUB_VIEWS[(idx + 1) % SUB_VIEWS.length];
  if (next) { host.setView(next); host.setMessage(`  ${TAB_ICONS[next]} ${next}`); }
}

function prevTab(host: NavigationHost): void {
  if (host.state.view === "Projects" || host.state.view === "Health") return;
  const idx = SUB_VIEWS.indexOf(host.state.view as typeof SUB_VIEWS[number]);
  const prev = SUB_VIEWS[(idx - 1 + SUB_VIEWS.length) % SUB_VIEWS.length];
  if (prev) { host.setView(prev); host.setMessage(`  ${TAB_ICONS[prev]} ${prev}`); }
}
