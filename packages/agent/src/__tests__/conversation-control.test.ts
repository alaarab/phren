import { describe, expect, it, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "node:child_process";
import type { LlmMessage } from "../providers/types.js";
import { createSession } from "../agent-loop.js";
import { undoCommand, clearCommand } from "../commands/info.js";
import type { CommandContext } from "../commands.js";
import { updatePlanTool, getPlan, clearPlan } from "../tools/update-plan.js";
import { buildContextSnippet } from "../memory/context.js";
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "../checkpoint.js";
import { persistFork, eventLogPath } from "../session/persist.js";

function user(text: string): LlmMessage {
  return { role: "user", content: text };
}

function assistant(text: string): LlmMessage {
  return { role: "assistant", content: text };
}

function appendTurn(session: ReturnType<typeof createSession>, turn: number, q: string, a: string): void {
  session.log.append("user/message", { message: user(q), source: "user", turn });
  session.log.append("assistant/message", { message: assistant(a), stop_reason: "end_turn", turn });
}

function contents(messages: readonly LlmMessage[]): unknown[] {
  return messages.map((m) => m.content);
}

describe("/undo through the durable log", () => {
  it("removes the last user turn, keeps the earlier one, and stays reconstructable", () => {
    const session = createSession(200_000);
    appendTurn(session, 0, "first question", "first answer");
    appendTurn(session, 1, "second question", "second answer");

    const ctx: CommandContext = { session, contextLimit: 200_000, undoStack: [] };
    expect(undoCommand(["/undo"], ctx)).toBe(true);

    const seen = contents(session.messages);
    expect(seen).toContain("first question");
    expect(seen).toContain("first answer");
    expect(seen).not.toContain("second question");
    expect(seen).not.toContain("second answer");
    expect(seen).toContain("[undone]");
    expect(() => session.log.assertReconstructs()).not.toThrow();
  });

  it("does nothing when there is no earlier turn", () => {
    const session = createSession(200_000);
    session.log.append("user/message", { message: user("only"), source: "user", turn: 0 });

    const ctx: CommandContext = { session, contextLimit: 200_000, undoStack: [] };
    expect(undoCommand(["/undo"], ctx)).toBe(true);
    expect(contents(session.messages)).toEqual(["only"]);
    expect(() => session.log.assertReconstructs()).not.toThrow();
  });
});

describe("/clear through the durable log", () => {
  it("collapses history into a single cleared note", () => {
    const session = createSession(200_000);
    appendTurn(session, 0, "q1", "a1");
    appendTurn(session, 1, "q2", "a2");
    session.turns = 2;
    session.toolCalls = 3;

    const ctx: CommandContext = { session, contextLimit: 200_000, undoStack: [] };
    expect(clearCommand(["/clear"], ctx)).toBe(true);

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe("[conversation cleared]");
    expect(session.turns).toBe(0);
    expect(session.toolCalls).toBe(0);
    expect(ctx.undoStack).toHaveLength(0);
    expect(() => session.log.assertReconstructs()).not.toThrow();
  });

  it("leaves an empty conversation empty", () => {
    const session = createSession(200_000);
    const ctx: CommandContext = { session, contextLimit: 200_000, undoStack: [] };
    expect(clearCommand(["/clear"], ctx)).toBe(true);
    expect(session.messages).toHaveLength(0);
    expect(() => session.log.assertReconstructs()).not.toThrow();
  });
});

describe("update_plan", () => {
  afterEach(() => clearPlan());

  it("stores plan items in order with their statuses", async () => {
    await updatePlanTool.execute({
      plan: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "completed" },
      ],
    });
    const plan = getPlan();
    expect(plan.map((p) => p.content)).toEqual(["a", "b"]);
    expect(plan.map((p) => p.status)).toEqual(["in_progress", "completed"]);
  });

  it("clears the plan when passed an empty array", async () => {
    await updatePlanTool.execute({ plan: [{ content: "a", status: "pending" }] });
    expect(getPlan()).toHaveLength(1);
    await updatePlanTool.execute({ plan: [] });
    expect(getPlan()).toEqual([]);
  });

  it("defaults an unknown status to pending", async () => {
    await updatePlanTool.execute({ plan: [{ content: "a", status: "bogus" }] });
    expect(getPlan()).toEqual([{ content: "a", status: "pending" }]);
  });
});

describe("AGENTS.md injection", () => {
  it("includes AGENTS.md under Project instructions", async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-agents-")));
    const prev = process.cwd();
    try {
      fs.writeFileSync(path.join(tmp, "AGENTS.md"), "# Agent rules\nAlways run the tests.");
      process.chdir(tmp);

      const snippet = await buildContextSnippet(
        { phrenPath: tmp, project: null, profile: null } as never,
        "x",
      );

      expect(snippet).toContain("## Project instructions");
      expect(snippet).toContain("Always run the tests.");
    } finally {
      process.chdir(prev);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("/fork persistence", () => {
  it("seeds a child log with the parent's history and links the parent", () => {
    const phrenPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-fork-")));
    try {
      const parent = createSession(200_000).log;
      parent.append("user/message", { message: user("q"), source: "user", turn: 0 });
      parent.append("assistant/message", { message: assistant("a"), stop_reason: "end_turn", turn: 0 });

      const childId = "11111111-1111-4111-8111-111111111111";
      const child = persistFork(phrenPath, parent, childId);

      expect(child.header.parentSession).toBe(parent.header.sessionId);
      expect(child.getMessages().map((m) => m.content)).toEqual(["q", "a"]);

      const file = eventLogPath(phrenPath, childId);
      expect(fs.existsSync(file)).toBe(true);
      const lines = fs.readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
      expect(lines[0].type).toBe("header");
      expect(lines[0].sessionId).toBe(childId);
      expect(lines[0].parentSession).toBe(parent.header.sessionId);
    } finally {
      fs.rmSync(phrenPath, { recursive: true, force: true });
    }
  });
});

describe("checkpoints in a temp git repo", () => {
  it("creates, lists, and restores a checkpoint", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-ckpt-")));
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-ckpt-home-")));
    const prevCwd = process.cwd();
    const prevHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const git = (args: string[]) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

      git(["init"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test User"]);

      const file = path.join(dir, "file.txt");
      fs.writeFileSync(file, "one\n");
      git(["add", "file.txt"]);
      git(["commit", "-m", "initial"]);

      fs.writeFileSync(file, "two\n");
      const ref = createCheckpoint(dir, "c1");
      expect(ref).toBeTruthy();

      fs.writeFileSync(file, "three\n");
      process.chdir(dir);
      expect(listCheckpoints().map((c) => c.label)).toContain("c1");

      const result = restoreCheckpoint(dir, ref as string);
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(file, "utf-8")).toBe("two\n");
    } finally {
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
