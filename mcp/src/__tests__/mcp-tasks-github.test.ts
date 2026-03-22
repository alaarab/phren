import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { register } from "../tools/tasks.js";
import { readTasks } from "../data/access.js";
import type { McpContext } from "../tools/types.js";

vi.mock("../task/github.js", () => ({
  buildTaskIssueBody: vi.fn(() => "generated body"),
  createGithubIssueForTask: vi.fn(() => ({
    ok: true,
    data: {
      repo: "alaarab/phren",
      issueNumber: 14,
      url: "https://github.com/alaarab/phren/issues/14",
    },
  })),
  parseGithubIssueUrl: vi.fn((url: string) => {
    const match = url.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
    return match ? { repo: match[1], issueNumber: Number.parseInt(match[2], 10), url } : null;
  }),
  resolveProjectGithubRepo: vi.fn(() => "alaarab/phren"),
}));

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

function makeMockServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    registerTool(name: string, _meta: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
    call(name: string, args: Record<string, unknown>) {
      const handler = tools.get(name);
      if (!handler) throw new Error(`Tool "${name}" not registered`);
      return handler(args);
    },
  };
}

function parseResult(res: { content: { type: string; text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

function makeCtx(phrenPath: string): McpContext {
  return {
    phrenPath,
    profile: "test",
    db: () => { throw new Error("db not expected"); },
    rebuildIndex: async () => {},
    updateFileInIndex: () => {},
    withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
  };
}

describe("mcp-tasks GitHub issue tools", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  const project = "phren";

  beforeEach(() => {
    tmp = makeTempDir("mcp-tasks-github-");
    grantAdmin(tmp.path);
    fs.mkdirSync(path.join(tmp.path, project), { recursive: true });
    fs.writeFileSync(
      path.join(tmp.path, project, "tasks.md"),
      "# phren task\n\n## Active\n\n## Queue\n\n- [ ] Ship issue linking <!-- bid:deadbeef -->\n  Context: Task items should optionally link to GitHub issues\n\n## Done\n"
    );
    server = makeMockServer();
    register(server as any, makeCtx(tmp.path));
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("links an existing GitHub issue to a task via update_task", async () => {
    const res = parseResult(await server.call("update_task", {
      project,
      item: "bid:deadbeef",
      updates: {
        github_issue: 14,
        github_url: "https://github.com/alaarab/phren/issues/14",
      },
    }));
    expect(res.ok).toBe(true);
    expect(res.data.githubIssue).toBe(14);

    const task = readTasks(tmp.path, project);
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    expect(task.data.items.Queue[0].githubIssue).toBe(14);
    expect(task.data.items.Queue[0].githubUrl).toBe("https://github.com/alaarab/phren/issues/14");
  });
});
