import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { register } from "../mcp-backlog.js";
import { readBacklog } from "../data-access.js";
import type { McpContext } from "../mcp-types.js";

vi.mock("../backlog-github.js", () => ({
  buildBacklogIssueBody: vi.fn(() => "generated body"),
  createGithubIssueForBacklog: vi.fn(() => ({
    ok: true,
    data: {
      repo: "alaarab/cortex",
      issueNumber: 14,
      url: "https://github.com/alaarab/cortex/issues/14",
    },
  })),
  parseGithubIssueUrl: vi.fn((url: string) => {
    const match = url.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
    return match ? { repo: match[1], issueNumber: Number.parseInt(match[2], 10), url } : null;
  }),
  resolveProjectGithubRepo: vi.fn(() => "alaarab/cortex"),
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

function makeCtx(cortexPath: string): McpContext {
  return {
    cortexPath,
    profile: "test",
    db: () => { throw new Error("db not expected"); },
    rebuildIndex: async () => {},
    updateFileInIndex: () => {},
    withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
  };
}

describe("mcp-backlog GitHub issue tools", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  const project = "cortex";

  beforeEach(() => {
    tmp = makeTempDir("mcp-backlog-github-");
    grantAdmin(tmp.path);
    fs.mkdirSync(path.join(tmp.path, project), { recursive: true });
    fs.writeFileSync(
      path.join(tmp.path, project, "backlog.md"),
      "# cortex backlog\n\n## Active\n\n## Queue\n\n- [ ] Ship issue linking <!-- bid:deadbeef -->\n  Context: Backlog items should optionally link to GitHub issues\n\n## Done\n"
    );
    server = makeMockServer();
    register(server as any, makeCtx(tmp.path));
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("links an existing GitHub issue to a task", async () => {
    const res = parseResult(await server.call("link_task_issue", {
      project,
      item: "bid:deadbeef",
      issue_number: 14,
      issue_url: "https://github.com/alaarab/cortex/issues/14",
    }));
    expect(res.ok).toBe(true);
    expect(res.data.githubIssue).toBe(14);

    const backlog = readBacklog(tmp.path, project);
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;
    expect(backlog.data.items.Queue[0].githubIssue).toBe(14);
    expect(backlog.data.items.Queue[0].githubUrl).toBe("https://github.com/alaarab/cortex/issues/14");
  });

  it("promotes a task into a GitHub issue and links it back", async () => {
    const res = parseResult(await server.call("promote_task_to_issue", {
      project,
      item: "bid:deadbeef",
    }));
    expect(res.ok).toBe(true);
    expect(res.data.githubIssue).toBe(14);
    expect(res.data.githubUrl).toBe("https://github.com/alaarab/cortex/issues/14");

    const backlog = readBacklog(tmp.path, project);
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;
    expect(backlog.data.items.Queue[0].githubIssue).toBe(14);
  });

  it("can mark the item done after promotion", async () => {
    const res = parseResult(await server.call("promote_task_to_issue", {
      project,
      item: "bid:deadbeef",
      mark_done: true,
    }));
    expect(res.ok).toBe(true);

    const backlog = readBacklog(tmp.path, project);
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;
    expect(backlog.data.items.Queue).toHaveLength(0);
    expect(backlog.data.items.Done[0].githubIssue).toBe(14);
  });
});
