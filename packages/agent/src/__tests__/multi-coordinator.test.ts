import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TeamCoordinator } from "../multi/coordinator.js";

let tmpDir: string;
let coordinator: TeamCoordinator;

/** Override the coordinator's filePath to use a temp directory. */
function createCoordinator(teamName = "test-team"): TeamCoordinator {
  const c = new TeamCoordinator(teamName);
  // Point filePath at our temp dir instead of ~/.phren-agent
  const tasksPath = path.join(tmpDir, "tasks.json");
  Object.defineProperty(c, "filePath", { value: tasksPath, writable: false });
  return c;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-coord-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("TeamCoordinator", () => {
  beforeEach(() => {
    coordinator = createCoordinator();
  });

  describe("createTask", () => {
    it("creates a task with auto-incremented ID", () => {
      const t1 = coordinator.createTask("Task one", "Description one");
      expect(t1.id).toBe("1");
      expect(t1.subject).toBe("Task one");
      expect(t1.description).toBe("Description one");
      expect(t1.status).toBe("pending");
      expect(t1.owner).toBeNull();
      expect(t1.blockedBy).toEqual([]);

      const t2 = coordinator.createTask("Task two", "Description two");
      expect(t2.id).toBe("2");
    });

    it("creates a task with blockedBy dependencies", () => {
      const t1 = coordinator.createTask("First", "do first");
      const t2 = coordinator.createTask("Second", "do second", [t1.id]);
      expect(t2.blockedBy).toEqual(["1"]);
    });

    it("persists tasks to disk", () => {
      coordinator.createTask("Persistent", "should survive re-read");
      const raw = JSON.parse(fs.readFileSync(coordinator.filePath, "utf-8"));
      expect(raw.tasks).toHaveLength(1);
      expect(raw.tasks[0].subject).toBe("Persistent");
    });
  });

  describe("claimTask", () => {
    it("claims the first pending task", () => {
      coordinator.createTask("A", "first");
      coordinator.createTask("B", "second");

      const claimed = coordinator.claimTask("agent-1");
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe("1");
      expect(claimed!.status).toBe("claimed");
      expect(claimed!.owner).toBe("agent-1");
    });

    it("returns null when no tasks are pending", () => {
      const claimed = coordinator.claimTask("agent-1");
      expect(claimed).toBeNull();
    });

    it("skips already-claimed tasks", () => {
      coordinator.createTask("A", "first");
      coordinator.createTask("B", "second");

      coordinator.claimTask("agent-1"); // claims A
      const claimed = coordinator.claimTask("agent-2");
      expect(claimed!.id).toBe("2");
      expect(claimed!.owner).toBe("agent-2");
    });

    it("skips tasks blocked by incomplete dependencies", () => {
      const t1 = coordinator.createTask("Dep", "dependency");
      coordinator.createTask("Blocked", "needs dep", [t1.id]);

      // Only t1 should be claimable since t2 is blocked
      const claimed = coordinator.claimTask("agent-1");
      expect(claimed!.id).toBe("1");

      // Now nothing else is claimable (t2 still blocked)
      const next = coordinator.claimTask("agent-2");
      expect(next).toBeNull();
    });

    it("unblocks tasks once dependencies complete", () => {
      const t1 = coordinator.createTask("Dep", "dependency");
      coordinator.createTask("Blocked", "needs dep", [t1.id]);

      // Claim and complete t1
      coordinator.claimTask("agent-1");
      coordinator.startTask(t1.id, "agent-1");
      coordinator.completeTask(t1.id, "agent-1", "done");

      // Now t2 should be claimable
      const claimed = coordinator.claimTask("agent-2");
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe("2");
    });
  });

  describe("startTask", () => {
    it("transitions claimed task to in_progress", () => {
      coordinator.createTask("Work", "do it");
      coordinator.claimTask("agent-1");

      coordinator.startTask("1", "agent-1");

      const task = coordinator.getTask("1");
      expect(task!.status).toBe("in_progress");
    });

    it("throws if task is not claimed", () => {
      coordinator.createTask("Work", "do it");
      // Owner check runs first (owner is null), so the error is about ownership
      expect(() => coordinator.startTask("1", "agent-1")).toThrow(
        'Task 1 is owned by "null", not "agent-1"',
      );
    });

    it("throws if wrong agent tries to start", () => {
      coordinator.createTask("Work", "do it");
      coordinator.claimTask("agent-1");

      expect(() => coordinator.startTask("1", "agent-2")).toThrow(
        'Task 1 is owned by "agent-1", not "agent-2"',
      );
    });

    it("throws for non-existent task", () => {
      expect(() => coordinator.startTask("999", "agent-1")).toThrow(
        "Task 999 not found",
      );
    });
  });

  describe("completeTask", () => {
    it("marks task as completed with result", () => {
      coordinator.createTask("Work", "do it");
      coordinator.claimTask("agent-1");
      coordinator.startTask("1", "agent-1");
      coordinator.completeTask("1", "agent-1", "All done");

      const task = coordinator.getTask("1");
      expect(task!.status).toBe("completed");
      expect(task!.result).toBe("All done");
      expect(task!.completedAt).toBeTruthy();
    });

    it("throws if wrong agent completes", () => {
      coordinator.createTask("Work", "do it");
      coordinator.claimTask("agent-1");

      expect(() => coordinator.completeTask("1", "agent-2")).toThrow(
        'Task 1 is owned by "agent-1", not "agent-2"',
      );
    });
  });

  describe("failTask", () => {
    it("marks task as failed with error", () => {
      coordinator.createTask("Risky", "might fail");
      coordinator.claimTask("agent-1");
      coordinator.startTask("1", "agent-1");
      coordinator.failTask("1", "agent-1", "Something went wrong");

      const task = coordinator.getTask("1");
      expect(task!.status).toBe("failed");
      expect(task!.error).toBe("Something went wrong");
      expect(task!.completedAt).toBeTruthy();
    });
  });

  describe("getTaskList", () => {
    it("returns a snapshot of all tasks", () => {
      coordinator.createTask("A", "first");
      coordinator.createTask("B", "second");
      coordinator.createTask("C", "third");

      const list = coordinator.getTaskList();
      expect(list).toHaveLength(3);
      expect(list.map((t) => t.subject)).toEqual(["A", "B", "C"]);
    });

    it("returns a clone (mutations don't affect storage)", () => {
      coordinator.createTask("A", "first");
      const list = coordinator.getTaskList();
      list[0].subject = "MUTATED";

      const fresh = coordinator.getTaskList();
      expect(fresh[0].subject).toBe("A");
    });
  });

  describe("getAgentTask", () => {
    it("returns the active task for an agent", () => {
      coordinator.createTask("A", "first");
      coordinator.claimTask("agent-1");

      const task = coordinator.getAgentTask("agent-1");
      expect(task).not.toBeNull();
      expect(task!.subject).toBe("A");
    });

    it("returns null for agents with no active task", () => {
      expect(coordinator.getAgentTask("nobody")).toBeNull();
    });

    it("returns null after task is completed", () => {
      coordinator.createTask("A", "first");
      coordinator.claimTask("agent-1");
      coordinator.startTask("1", "agent-1");
      coordinator.completeTask("1", "agent-1");

      expect(coordinator.getAgentTask("agent-1")).toBeNull();
    });
  });

  describe("getUnblockedTasks", () => {
    it("returns pending tasks with all deps completed", () => {
      const t1 = coordinator.createTask("Dep", "dep");
      coordinator.createTask("Free", "no deps");
      coordinator.createTask("Blocked", "blocked", [t1.id]);

      const unblocked = coordinator.getUnblockedTasks();
      expect(unblocked.map((t) => t.subject)).toEqual(["Dep", "Free"]);
    });
  });

  describe("formatStatus", () => {
    it("returns a readable status string", () => {
      coordinator.createTask("Build app", "build");
      coordinator.createTask("Write tests", "tests");
      coordinator.claimTask("agent-1");

      const status = coordinator.formatStatus();
      expect(status).toContain('Team "test-team"');
      expect(status).toContain("Build app");
      expect(status).toContain("Write tests");
      expect(status).toContain("[claimed]");
      expect(status).toContain("[pending]");
    });

    it("handles empty task list", () => {
      expect(coordinator.formatStatus()).toContain("no tasks");
    });
  });

  describe("task lifecycle transitions", () => {
    it("pending -> claimed -> in_progress -> completed", () => {
      coordinator.createTask("Full lifecycle", "test all states");

      let task = coordinator.getTask("1")!;
      expect(task.status).toBe("pending");

      coordinator.claimTask("agent-1");
      task = coordinator.getTask("1")!;
      expect(task.status).toBe("claimed");
      expect(task.claimedAt).toBeTruthy();

      coordinator.startTask("1", "agent-1");
      task = coordinator.getTask("1")!;
      expect(task.status).toBe("in_progress");

      coordinator.completeTask("1", "agent-1", "success");
      task = coordinator.getTask("1")!;
      expect(task.status).toBe("completed");
      expect(task.completedAt).toBeTruthy();
      expect(task.result).toBe("success");
    });

    it("pending -> claimed -> in_progress -> failed", () => {
      coordinator.createTask("Failing task", "will fail");

      coordinator.claimTask("agent-1");
      coordinator.startTask("1", "agent-1");
      coordinator.failTask("1", "agent-1", "crashed");

      const task = coordinator.getTask("1")!;
      expect(task.status).toBe("failed");
      expect(task.error).toBe("crashed");
    });
  });

  describe("atomic claiming (concurrent access)", () => {
    it("two coordinators pointing at same file cannot double-claim", () => {
      // Both coordinators share the same tasks.json via tmpDir
      const c1 = createCoordinator();
      const c2 = createCoordinator();

      c1.createTask("Only one", "should be claimed once");

      const claim1 = c1.claimTask("agent-1");
      const claim2 = c2.claimTask("agent-2");

      // One should get the task, the other should get null
      expect(claim1).not.toBeNull();
      expect(claim2).toBeNull();
    });

    it("sequential claims across coordinators work correctly", () => {
      const c1 = createCoordinator();
      const c2 = createCoordinator();

      c1.createTask("Task A", "first");
      c1.createTask("Task B", "second");

      const claim1 = c1.claimTask("agent-1");
      const claim2 = c2.claimTask("agent-2");

      expect(claim1!.id).toBe("1");
      expect(claim2!.id).toBe("2");

      // No more tasks
      expect(c1.claimTask("agent-3")).toBeNull();
    });
  });
});
