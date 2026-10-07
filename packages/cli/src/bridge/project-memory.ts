import * as fs from "node:fs";
import * as path from "node:path";
import { readFindings, type FindingItem } from "../data/access.js";
import { readTasks, type TaskItem } from "../data/tasks.js";
import { taskStores } from "../data/task-store-directory.js";
import { FINDING_TAGS } from "../phren-core.js";
import { getProjectRemote, readProjectConfig } from "../project-config.js";
import { redactSecretsForLog } from "../content/secrets.js";
import { resolveProject } from "../store-routing.js";
import { isValidProjectName } from "../utils.js";
import { BridgeError } from "./protocol.js";

// `GET /v1/projects/:project/memory`: one project's findings, truths and
// tasks as a fixed read-only contract, for a client that renders them beside
// the repository (gitboy). Phren stays the source of truth; nothing here
// writes. The scoped `gitboy-read` SSH key reaches only this route
// (scoped-gateway.ts). Contract: docs/phren-hook.md#gitboy-read-only-memory.

export const PROJECT_MEMORY_ROUTE = /^\/v1\/projects\/([^/]+)\/memory$/;
export const MEMORY_LIMITS = { findings: 500, active: 200, queue: 200, done: 50 } as const;

export interface MemoryFinding {
  id: string; text: string; type: string | null; status: FindingItem["status"]; created: string | null;
  citation: { file: string | null; line: number | null; commit: string | null; name: string | null } | null;
}
export interface MemoryTask { id: string; text: string; created: string | null; context: string | null }
export interface ProjectMemory {
  project: string; store_id: string | null; remote: string | null; truncated: boolean;
  findings: MemoryFinding[]; truths: { text: string }[];
  tasks: { active: MemoryTask[]; queue: MemoryTask[]; done: MemoryTask[] };
}

const TAG = new RegExp(`^\\[(${FINDING_TAGS.join("|")})\\]\\s*`, "i");
const DATE = /^\d{4}-\d{2}-\d{2}/;

/** Text that trips phren's credential detector is withheld whole, never cut. */
const safe = (text: string) => redactSecretsForLog(text);

function finding(item: FindingItem): MemoryFinding {
  const tag = TAG.exec(item.text);
  const cite = item.citationData;
  const citation = cite && (cite.file || cite.line || cite.commit || cite.symbol)
    ? { file: cite.file ?? null, line: Number.isInteger(cite.line) ? cite.line! : null, commit: cite.commit ?? null, name: cite.symbol ?? null }
    : null;
  const created = DATE.test(item.date) ? item.date.slice(0, 10) : cite?.created_at && DATE.test(cite.created_at) ? cite.created_at.slice(0, 10) : null;
  return {
    id: item.stableId ? `fid:${item.stableId}` : item.id,
    text: safe(tag ? item.text.slice(tag[0].length) : item.text),
    type: tag ? tag[1].toLowerCase() : null,
    status: item.status, created, citation,
  };
}

function task(item: TaskItem): MemoryTask {
  return {
    id: item.stableId ? `bid:${item.stableId}` : item.id,
    text: safe(item.line), created: item.createdAt ?? null,
    context: item.context ? safe(item.context) : null,
  };
}

export function projectMemory(base: string, rawProject: string): ProjectMemory {
  let project: string;
  try { project = decodeURIComponent(rawProject); } catch { throw new BridgeError(400, "Invalid project name."); }
  if (!isValidProjectName(project)) throw new BridgeError(400, "Invalid project name.");
  let store: { path: string };
  try { store = resolveProject(base, project).store; }
  catch { throw new BridgeError(404, "Project not found."); }
  const root = store.path;
  const storeId = taskStores(base).find(entry => path.resolve(entry.path) === path.resolve(root))?.taskStoreId ?? null;

  const findingsResult = readFindings(root, project);
  if (!findingsResult.ok) throw new BridgeError(404, "Project not found.");
  // Newest first, so the cap drops the oldest. Undated findings sort last.
  const allFindings = findingsResult.data.map((item, index) => ({ item, index, date: DATE.test(item.date) ? item.date : "" }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.index - b.index).map(entry => entry.item);

  const truthsFile = path.join(root, project, "truths.md");
  const truths = fs.existsSync(truthsFile)
    ? fs.readFileSync(truthsFile, "utf8").split("\n").filter(line => line.startsWith("- ")).map(line => ({ text: safe(line.slice(2).trim()) }))
    : [];

  // Tasks are their own module; with it off the sections are empty.
  const taskDoc = readTasks(root, project);
  const items = taskDoc.ok ? taskDoc.data.items : { Active: [], Queue: [], Done: [] };

  const truncated = allFindings.length > MEMORY_LIMITS.findings || items.Active.length > MEMORY_LIMITS.active
    || items.Queue.length > MEMORY_LIMITS.queue || items.Done.length > MEMORY_LIMITS.done;
  return {
    project, store_id: storeId, remote: getProjectRemote(root, project, readProjectConfig(root, project)), truncated,
    findings: allFindings.slice(0, MEMORY_LIMITS.findings).map(finding),
    truths,
    tasks: {
      active: items.Active.slice(0, MEMORY_LIMITS.active).map(task),
      queue: items.Queue.slice(0, MEMORY_LIMITS.queue).map(task),
      // Done is newest first in tasks.md; keep the most recent.
      done: items.Done.slice(0, MEMORY_LIMITS.done).map(task),
    },
  };
}
