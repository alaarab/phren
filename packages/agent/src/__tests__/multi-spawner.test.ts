import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { AgentSpawner } from "../multi/spawner.js";

/**
 * Mock child_process.fork to avoid actually forking agent processes.
 * Returns a fake ChildProcess that supports send(), on(), kill(), and emits IPC messages.
 */

interface FakeChild extends EventEmitter {
  pid: number;
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  stderr: EventEmitter;
  connected: boolean;
}

function createFakeChild(pid = 1234): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.send = vi.fn();
  child.kill = vi.fn();
  child.stderr = new EventEmitter();
  child.connected = true;
  return child;
}

let fakeChildren: FakeChild[];
let nextPid: number;

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const child = createFakeChild(nextPid++);
    fakeChildren.push(child);
    return child;
  }),
}));

describe("AgentSpawner", () => {
  let spawner: AgentSpawner;

  beforeEach(() => {
    fakeChildren = [];
    nextPid = 1000;
    spawner = new AgentSpawner();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("spawn", () => {
    it("returns a unique agent ID", () => {
      const id1 = spawner.spawn({ task: "task one" });
      const id2 = spawner.spawn({ task: "task two" });

      expect(id1).toBe("agent-1");
      expect(id2).toBe("agent-2");
    });

    it("sends spawn payload to child process via IPC", () => {
      spawner.spawn({ task: "do something" });
      const child = fakeChildren[0];

      expect(child.send).toHaveBeenCalledOnce();
      const payload = child.send.mock.calls[0][0];
      expect(payload.type).toBe("spawn");
      expect(payload.task).toBe("do something");
      expect(payload.agentId).toBe("agent-1");
      expect(payload.permissions).toBe("auto-confirm");
      expect(payload.maxTurns).toBe(50);
    });

    it("registers agent entry with running status", () => {
      const id = spawner.spawn({ task: "work" });
      const agent = spawner.getAgent(id);

      expect(agent).toBeDefined();
      expect(agent!.status).toBe("running");
      expect(agent!.task).toBe("work");
      expect(agent!.pid).toBe(1000);
      expect(agent!.startedAt).toBeGreaterThan(0);
    });

    it("forwards spawn options correctly", () => {
      spawner.spawn({
        task: "test",
        provider: "anthropic",
        model: "claude-3-opus",
        permissions: "full-auto",
        maxTurns: 10,
        budget: 5.0,
        plan: true,
        verbose: true,
      });

      const payload = fakeChildren[0].send.mock.calls[0][0];
      expect(payload.provider).toBe("anthropic");
      expect(payload.model).toBe("claude-3-opus");
      expect(payload.permissions).toBe("full-auto");
      expect(payload.maxTurns).toBe(10);
      expect(payload.budget).toBe(5.0);
      expect(payload.plan).toBe(true);
      expect(payload.verbose).toBe(true);
    });
  });

  describe("listAgents", () => {
    it("returns all spawned agents", () => {
      spawner.spawn({ task: "A" });
      spawner.spawn({ task: "B" });
      spawner.spawn({ task: "C" });

      const agents = spawner.listAgents();
      expect(agents).toHaveLength(3);
      expect(agents.map((a) => a.task)).toEqual(["A", "B", "C"]);
    });

    it("returns empty array when no agents", () => {
      expect(spawner.listAgents()).toEqual([]);
    });
  });

  describe("getAgent", () => {
    it("returns agent entry by ID", () => {
      const id = spawner.spawn({ task: "find me" });
      const agent = spawner.getAgent(id);
      expect(agent!.task).toBe("find me");
    });

    it("returns undefined for unknown ID", () => {
      expect(spawner.getAgent("agent-999")).toBeUndefined();
    });
  });

  describe("getAgentsByStatus", () => {
    it("filters agents by status", () => {
      spawner.spawn({ task: "A" });
      spawner.spawn({ task: "B" });

      const running = spawner.getAgentsByStatus("running");
      expect(running).toHaveLength(2);

      const done = spawner.getAgentsByStatus("done");
      expect(done).toHaveLength(0);
    });
  });

  describe("IPC message routing", () => {
    it("emits text_delta events", () => {
      const id = spawner.spawn({ task: "stream" });
      const handler = vi.fn();
      spawner.on("text_delta", handler);

      fakeChildren[0].emit("message", {
        type: "text_delta",
        agentId: id,
        text: "hello",
      });

      expect(handler).toHaveBeenCalledWith(id, "hello");
    });

    it("emits text_block events", () => {
      const id = spawner.spawn({ task: "block" });
      const handler = vi.fn();
      spawner.on("text_block", handler);

      fakeChildren[0].emit("message", {
        type: "text_block",
        agentId: id,
        text: "full block",
      });

      expect(handler).toHaveBeenCalledWith(id, "full block");
    });

    it("emits tool_start events", () => {
      const id = spawner.spawn({ task: "tools" });
      const handler = vi.fn();
      spawner.on("tool_start", handler);

      fakeChildren[0].emit("message", {
        type: "tool_start",
        agentId: id,
        toolName: "read_file",
        input: { path: "/tmp/test" },
        count: 1,
      });

      expect(handler).toHaveBeenCalledWith(id, "read_file", { path: "/tmp/test" }, 1);
    });

    it("emits tool_end events", () => {
      const id = spawner.spawn({ task: "tools" });
      const handler = vi.fn();
      spawner.on("tool_end", handler);

      fakeChildren[0].emit("message", {
        type: "tool_end",
        agentId: id,
        toolName: "read_file",
        input: { path: "/tmp/test" },
        output: "file contents",
        isError: false,
        durationMs: 42,
      });

      expect(handler).toHaveBeenCalledWith(id, "read_file", { path: "/tmp/test" }, "file contents", false, 42);
    });

    it("stores result on done message but keeps agent alive", () => {
      const id = spawner.spawn({ task: "finish" });
      const handler = vi.fn();
      spawner.on("done", handler);

      const result = {
        finalText: "completed",
        turns: 3,
        toolCalls: 5,
        totalCost: "$0.02",
      };

      fakeChildren[0].emit("message", {
        type: "done",
        agentId: id,
        result,
      });

      expect(handler).toHaveBeenCalledWith(id, result);

      const agent = spawner.getAgent(id);
      // Agent stays running — will go idle after done (persistent process)
      expect(agent!.status).toBe("running");
      expect(agent!.result).toEqual(result);
    });

    it("stores error on error message but keeps agent alive", () => {
      const id = spawner.spawn({ task: "fail" });
      const handler = vi.fn();
      spawner.on("error", handler);

      fakeChildren[0].emit("message", {
        type: "error",
        agentId: id,
        error: "something broke",
      });

      expect(handler).toHaveBeenCalledWith(id, "something broke");

      const agent = spawner.getAgent(id);
      // Agent stays running — will go idle (persistent process)
      expect(agent!.status).toBe("running");
      expect(agent!.error).toBe("something broke");
    });

    it("transitions to idle on idle notification", () => {
      const id = spawner.spawn({ task: "idle me" });
      const handler = vi.fn();
      spawner.on("idle", handler);

      fakeChildren[0].emit("message", {
        type: "idle",
        agentId: id,
        idleReason: "task_complete",
      });

      expect(handler).toHaveBeenCalledWith(id, "task_complete", undefined);
      expect(spawner.getAgent(id)!.status).toBe("idle");
    });

    it("transitions to done on shutdown_approved", () => {
      const id = spawner.spawn({ task: "shutdown me" });
      const handler = vi.fn();
      spawner.on("shutdown_approved", handler);

      fakeChildren[0].emit("message", {
        type: "shutdown_approved",
        agentId: id,
      });

      expect(handler).toHaveBeenCalledWith(id);
      const agent = spawner.getAgent(id);
      expect(agent!.status).toBe("done");
      expect(agent!.finishedAt).toBeGreaterThan(0);
    });

    it("emits status events", () => {
      const id = spawner.spawn({ task: "status" });
      const handler = vi.fn();
      spawner.on("status", handler);

      fakeChildren[0].emit("message", {
        type: "status",
        agentId: id,
        message: "context pruned",
      });

      expect(handler).toHaveBeenCalledWith(id, "context pruned");
    });
  });

  describe("cancel", () => {
    it("sends cancel message to child process", () => {
      const id = spawner.spawn({ task: "cancel me" });
      const result = spawner.cancel(id);

      expect(result).toBe(true);
      expect(fakeChildren[0].send).toHaveBeenCalledTimes(2); // spawn + cancel
      const cancelMsg = fakeChildren[0].send.mock.calls[1][0];
      expect(cancelMsg.type).toBe("cancel");
      expect(cancelMsg.agentId).toBe(id);
    });

    it("sets agent status to cancelled", () => {
      const id = spawner.spawn({ task: "cancel me" });
      spawner.cancel(id);

      const agent = spawner.getAgent(id);
      expect(agent!.status).toBe("cancelled");
      expect(agent!.finishedAt).toBeGreaterThan(0);
    });

    it("returns false for unknown agent", () => {
      expect(spawner.cancel("agent-999")).toBe(false);
    });
  });

  describe("child exit handling", () => {
    it("marks agent as done on clean exit", () => {
      const id = spawner.spawn({ task: "exit clean" });
      fakeChildren[0].emit("exit", 0);

      const agent = spawner.getAgent(id);
      expect(agent!.status).toBe("done");
      expect(agent!.finishedAt).toBeGreaterThan(0);
    });

    it("marks agent as error on non-zero exit", () => {
      const id = spawner.spawn({ task: "exit dirty" });
      fakeChildren[0].emit("exit", 1);

      const agent = spawner.getAgent(id);
      expect(agent!.status).toBe("error");
      expect(agent!.error).toContain("exited with code 1");
    });

    it("emits exit event", () => {
      const id = spawner.spawn({ task: "exit" });
      const handler = vi.fn();
      spawner.on("exit", handler);

      fakeChildren[0].emit("exit", 0);
      expect(handler).toHaveBeenCalledWith(id, 0);
    });
  });

  describe("shutdown", () => {
    it("cancels all running agents", async () => {
      spawner.spawn({ task: "A" });
      spawner.spawn({ task: "B" });

      // Simulate children exiting after cancel
      const shutdownPromise = spawner.shutdown();

      // Fake exits after a short delay
      for (const child of fakeChildren) {
        child.emit("exit", 0);
      }

      await shutdownPromise;

      const agents = spawner.listAgents();
      expect(agents.every((a) => a.status !== "running")).toBe(true);
    });

    it("resolves immediately when no agents exist", async () => {
      await spawner.shutdown();
      // Should not hang
    });
  });
});
