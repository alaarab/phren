import * as fs from "fs";
import * as path from "path";
import { errorMessage } from "./utils.js";
import { debugLog, sessionMarker } from "./shared.js";

export interface TaskCheckpoint {
  project: string;
  taskId: string;
  taskText?: string;
  taskLine: string;
  sessionId?: string;
  createdAt: string;
  resumptionHint: {
    lastAttempt: string;
    nextStep: string;
  };
  gitStatus: string;
  editedFiles: string[];
  failingTests: string[];
}

function sanitizeFileSegment(value: string): string {
  const trimmed = value.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return safe || "unknown";
}

function checkpointDir(cortexPath: string): string {
  const probe = sessionMarker(cortexPath, "checkpoint-probe.json");
  return path.dirname(probe);
}

function checkpointFileName(project: string, taskId: string): string {
  return `checkpoint-${sanitizeFileSegment(project)}-${sanitizeFileSegment(taskId)}.json`;
}

export function checkpointPath(cortexPath: string, project: string, taskId: string): string {
  return sessionMarker(cortexPath, checkpointFileName(project, taskId));
}

function readCheckpointFile(filePath: string): TaskCheckpoint | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<TaskCheckpoint>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.project !== "string" || typeof parsed.taskId !== "string" || typeof parsed.taskLine !== "string") return null;
    return {
      project: parsed.project,
      taskId: parsed.taskId,
      taskText: typeof parsed.taskText === "string" ? parsed.taskText : parsed.taskLine,
      taskLine: parsed.taskLine,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      resumptionHint: {
        lastAttempt: parsed.resumptionHint?.lastAttempt && typeof parsed.resumptionHint.lastAttempt === "string"
          ? parsed.resumptionHint.lastAttempt
          : "No prior attempt captured",
        nextStep: parsed.resumptionHint?.nextStep && typeof parsed.resumptionHint.nextStep === "string"
          ? parsed.resumptionHint.nextStep
          : parsed.taskLine,
      },
      gitStatus: typeof parsed.gitStatus === "string" ? parsed.gitStatus : "",
      editedFiles: Array.isArray(parsed.editedFiles) ? parsed.editedFiles.filter((v): v is string => typeof v === "string") : [],
      failingTests: Array.isArray(parsed.failingTests) ? parsed.failingTests.filter((v): v is string => typeof v === "string") : [],
    };
  } catch (err: unknown) {
    debugLog(`checkpoint read ${filePath}: ${errorMessage(err)}`);
    return null;
  }
}

export function writeTaskCheckpoint(cortexPath: string, checkpoint: TaskCheckpoint): void {
  const filePath = checkpointPath(cortexPath, checkpoint.project, checkpoint.taskId);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const normalizedCheckpoint: TaskCheckpoint = {
    ...checkpoint,
    taskText: checkpoint.taskText ?? checkpoint.taskLine,
  };
  fs.writeFileSync(tmpPath, JSON.stringify(normalizedCheckpoint, null, 2) + "\n");
  fs.renameSync(tmpPath, filePath);
}

export function listTaskCheckpoints(cortexPath: string, project?: string): TaskCheckpoint[] {
  const dir = checkpointDir(cortexPath);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const rows: Array<{ checkpoint: TaskCheckpoint; mtimeMs: number }> = [];
  for (const name of files) {
    if (!name.startsWith("checkpoint-") || !name.endsWith(".json")) continue;
    const filePath = path.join(dir, name);
    const parsed = readCheckpointFile(filePath);
    if (!parsed) continue;
    if (project && parsed.project !== project) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      // keep 0
    }
    rows.push({ checkpoint: parsed, mtimeMs });
  }

  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows.map((row) => row.checkpoint);
}

export function clearTaskCheckpoint(cortexPath: string, args: {
  project: string;
  taskId?: string;
  stableId?: string;
  positionalId?: string;
  taskLine?: string;
}): number {
  const ids = new Set<string>();
  if (args.taskId) ids.add(args.taskId);
  if (args.stableId) ids.add(args.stableId);
  if (args.positionalId) ids.add(args.positionalId);

  let removed = 0;
  for (const id of ids) {
    const filePath = checkpointPath(cortexPath, args.project, id);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch (err: unknown) {
      debugLog(`checkpoint clear ${filePath}: ${errorMessage(err)}`);
    }
  }

  const allProjectCheckpoints = listTaskCheckpoints(cortexPath, args.project);
  for (const checkpoint of allProjectCheckpoints) {
    const idMatch = ids.size > 0 && ids.has(checkpoint.taskId);
    const lineMatch = args.taskLine && checkpoint.taskLine === args.taskLine;
    if (!idMatch && !lineMatch) continue;
    const filePath = checkpointPath(cortexPath, checkpoint.project, checkpoint.taskId);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch (err: unknown) {
      debugLog(`checkpoint clear scan ${filePath}: ${errorMessage(err)}`);
    }
  }

  return removed;
}
