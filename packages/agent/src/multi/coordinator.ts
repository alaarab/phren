/**
 * Task-based coordination for multi-agent teams.
 *
 * Manages a shared JSON task list at ~/.phren-agent/teams/<team>/tasks.json.
 * Multiple child processes may claim tasks concurrently — all mutations go
 * through file locking + atomic rename to prevent corruption.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// ── Types ───────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "claimed" | "in_progress" | "completed" | "failed";

export interface TeamTask {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  result: string | null;
  error: string | null;
  blockedBy: string[];
}

interface TaskFile {
  teamName: string;
  tasks: TeamTask[];
  createdAt: string;
  updatedAt: string;
}

// ── File Locking ────────────────────────────────────────────────────────

const LOCK_MAX_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function acquireLock(lockPath: string): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  let waited = 0;
  while (waited < LOCK_MAX_WAIT_MS) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: "wx" });
      return; // acquired
    } catch {
      // Lock exists — check if stale
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          // Check if owner process is alive
          let alive = false;
          try {
            const content = fs.readFileSync(lockPath, "utf-8");
            const pid = parseInt(content.split("\n")[0], 10);
            if (pid > 0) {
              try { process.kill(pid, 0); alive = true; } catch { /* dead */ }
            }
          } catch { /* file vanished */ }
          if (!alive) {
            try { fs.unlinkSync(lockPath); } catch { /* gone */ }
            continue;
          }
        }
      } catch { /* stat failed, retry */ }
      sleepSync(LOCK_POLL_MS);
      waited += LOCK_POLL_MS;
    }
  }
  throw new Error(`TeamCoordinator: could not acquire lock within ${LOCK_MAX_WAIT_MS}ms`);
}

function releaseLock(lockPath: string): void {
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
}

function withLock<T>(filePath: string, fn: () => T): T {
  const lockPath = filePath + ".lock";
  acquireLock(lockPath);
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

// ── Atomic File Write ───────────────────────────────────────────────────

function atomicWriteJsonSync(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(6).toString("hex")}`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

// ── Coordinator ─────────────────────────────────────────────────────────

export class TeamCoordinator {
  readonly teamName: string;
  readonly filePath: string;

  constructor(teamName: string) {
    this.teamName = teamName;
    this.filePath = path.join(
      os.homedir(),
      ".phren-agent",
      "teams",
      teamName,
      "tasks.json",
    );
  }

  // ── Read / Write helpers (always called inside a lock) ──────────────

  private readFile(): TaskFile {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw) as TaskFile;
    } catch {
      const now = new Date().toISOString();
      return { teamName: this.teamName, tasks: [], createdAt: now, updatedAt: now };
    }
  }

  private writeFile(data: TaskFile): void {
    data.updatedAt = new Date().toISOString();
    atomicWriteJsonSync(this.filePath, data);
  }

  private nextId(data: TaskFile): string {
    if (data.tasks.length === 0) return "1";
    const max = Math.max(...data.tasks.map((t) => parseInt(t.id, 10) || 0));
    return String(max + 1);
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Add a new task to the list. Returns the created task. */
  createTask(subject: string, description: string, blockedBy?: string[]): TeamTask {
    return withLock(this.filePath, () => {
      const data = this.readFile();
      const task: TeamTask = {
        id: this.nextId(data),
        subject,
        description,
        status: "pending",
        owner: null,
        createdAt: new Date().toISOString(),
        claimedAt: null,
        completedAt: null,
        result: null,
        error: null,
        blockedBy: blockedBy ?? [],
      };
      data.tasks.push(task);
      this.writeFile(data);
      return task;
    });
  }

  /**
   * Atomically claim the next available task for an agent.
   * Skips tasks that are blocked by incomplete dependencies.
   * Returns null if nothing is available.
   */
  claimTask(agentName: string): TeamTask | null {
    return withLock(this.filePath, () => {
      const data = this.readFile();
      const completedIds = new Set(
        data.tasks.filter((t) => t.status === "completed").map((t) => t.id),
      );

      for (const task of data.tasks) {
        if (task.status !== "pending") continue;
        // Check blockedBy — all listed tasks must be completed
        const blocked = task.blockedBy.some((depId) => !completedIds.has(depId));
        if (blocked) continue;

        task.status = "claimed";
        task.owner = agentName;
        task.claimedAt = new Date().toISOString();
        this.writeFile(data);
        return task;
      }
      return null;
    });
  }

  /** Transition a claimed task to in_progress. */
  startTask(taskId: string, agentName: string): void {
    withLock(this.filePath, () => {
      const data = this.readFile();
      const task = data.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      if (task.owner !== agentName) {
        throw new Error(`Task ${taskId} is owned by "${task.owner}", not "${agentName}"`);
      }
      if (task.status !== "claimed") {
        throw new Error(`Task ${taskId} is "${task.status}", expected "claimed"`);
      }
      task.status = "in_progress";
      this.writeFile(data);
    });
  }

  /** Mark a task as completed. */
  completeTask(taskId: string, agentName: string, result?: string): void {
    withLock(this.filePath, () => {
      const data = this.readFile();
      const task = data.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      if (task.owner !== agentName) {
        throw new Error(`Task ${taskId} is owned by "${task.owner}", not "${agentName}"`);
      }
      task.status = "completed";
      task.completedAt = new Date().toISOString();
      task.result = result ?? null;
      this.writeFile(data);
    });
  }

  /** Mark a task as failed. */
  failTask(taskId: string, agentName: string, error: string): void {
    withLock(this.filePath, () => {
      const data = this.readFile();
      const task = data.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      if (task.owner !== agentName) {
        throw new Error(`Task ${taskId} is owned by "${task.owner}", not "${agentName}"`);
      }
      task.status = "failed";
      task.completedAt = new Date().toISOString();
      task.error = error;
      this.writeFile(data);
    });
  }

  /** Get the full task list (read-only snapshot). */
  getTaskList(): TeamTask[] {
    return withLock(this.filePath, () => {
      return structuredClone(this.readFile().tasks);
    });
  }

  /** Get the task currently assigned to an agent, or null. */
  getAgentTask(agentName: string): TeamTask | null {
    return withLock(this.filePath, () => {
      const data = this.readFile();
      return (
        data.tasks.find(
          (t) =>
            t.owner === agentName &&
            (t.status === "claimed" || t.status === "in_progress"),
        ) ?? null
      );
    });
  }

  /** Get a single task by ID. */
  getTask(taskId: string): TeamTask | null {
    return withLock(this.filePath, () => {
      const data = this.readFile();
      return data.tasks.find((t) => t.id === taskId) ?? null;
    });
  }

  /** Return all tasks that are now unblocked (pending with all deps completed). */
  getUnblockedTasks(): TeamTask[] {
    return withLock(this.filePath, () => {
      const data = this.readFile();
      const completedIds = new Set(
        data.tasks.filter((t) => t.status === "completed").map((t) => t.id),
      );
      return data.tasks.filter(
        (t) =>
          t.status === "pending" &&
          t.blockedBy.every((depId) => completedIds.has(depId)),
      );
    });
  }

  /** Summary string for display. */
  formatStatus(): string {
    const tasks = this.getTaskList();
    if (tasks.length === 0) return `Team "${this.teamName}": no tasks`;

    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;

    const lines = [`Team "${this.teamName}" — ${tasks.length} tasks:`];
    for (const t of tasks) {
      const owner = t.owner ? ` [${t.owner}]` : "";
      const blocked = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
      lines.push(`  #${t.id} [${t.status}]${owner} ${t.subject}${blocked}`);
    }
    const summary = Object.entries(counts)
      .map(([s, c]) => `${s}: ${c}`)
      .join(", ");
    lines.push(`  (${summary})`);
    return lines.join("\n");
  }
}
