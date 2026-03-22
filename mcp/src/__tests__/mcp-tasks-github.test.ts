import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { register } from "../tools/tasks.js";
import { readTasks } from "../data/access.js";
import type { McpContext } from "../tools/types.js";

describe("tasks-github helpers", () => {
  it("parses GitHub issue URLs into repo and issue number", async () => {
    const { parseGithubIssueUrl } = await vi.importActual<typeof import("../task/github.js")>("../task/github.js");
    expect(parseGithubIssueUrl("https://github.com/alaarab/phren/issues/14")).toEqual({
      repo: "alaarab/phren",
      issueNumber: 14,
      url: "https://github.com/alaarab/phren/issues/14",
    });
  });

  it("extracts a GitHub repo from markdown text", async () => {
    const { extractGithubRepoFromText } = await vi.importActual<typeof import("../task/github.js")>("../task/github.js");
    expect(extractGithubRepoFromText("Repo: https://github.com/alaarab/phren\n")).toBe("alaarab/phren");
  });

  it("builds an issue body from task item context", async () => {
    const { buildTaskIssueBody } = await vi.importActual<typeof import("../task/github.js")>("../task/github.js");
    const body = buildTaskIssueBody("phren", {
      id: "Q1",
      stableId: "deadbeef",
      section: "Queue",
      line: "Ship GitHub issue linkage [high]",
      checked: false,
      context: "Need optional issue linkage for task items",
      githubIssue: undefined,
      githubUrl: undefined,
    });
    expect(body).toContain("Ship GitHub issue linkage");
    expect(body).toContain("Need optional issue linkage");
    expect(body).toContain("bid:deadbeef");
  });
});

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
