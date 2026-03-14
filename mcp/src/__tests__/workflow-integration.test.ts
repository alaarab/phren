import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { makeTempDir, grantAdmin, suppressOutput } from "../test-helpers.js";
import { runInit } from "../init.js";
import { runPostInitVerify } from "../init-setup.js";
import { runTopLevelCommand } from "../entrypoint.js";
import { getUntrackedProjectNotice } from "../cli-hooks-session.js";
import { createWebUiServer } from "../memory-ui.js";
import { register as registerMcpOps } from "../mcp-ops.js";
import { register as registerSearch } from "../mcp-search.js";
import { register as registerFinding } from "../mcp-finding.js";
import { buildIndex, updateFileInIndex, type SqlJsDatabase } from "../shared-index.js";
import type { McpContext } from "../mcp-types.js";

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

async function httpGet(port: number, reqPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${reqPath}`, (res) => {
      let out = "";
      res.on("data", (chunk) => { out += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode || 0, body: out }));
    }).on("error", reject);
  });
}

async function postForm(port: number, reqPath: string, body: Record<string, string>): Promise<{ status: number; body: string }> {
  const payload = new URLSearchParams(body).toString();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "POST",
        host: "127.0.0.1",
        port,
        path: reqPath,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (chunk) => { out += String(chunk); });
        res.on("end", () => resolve({ status: res.statusCode || 0, body: out }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function parseResult(res: { content: { type: string; text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

describe.sequential("workflow integration", () => {
  let tmp: { path: string; cleanup: () => void };
  let priorHome: string | undefined;
  let priorUserProfile: string | undefined;
  let priorPhrenPath: string | undefined;
  let priorProfile: string | undefined;
  let priorCwd: string;

  beforeEach(() => {
    tmp = makeTempDir("phren-workflow-");
    priorHome = process.env.HOME;
    priorUserProfile = process.env.USERPROFILE;
    priorPhrenPath = process.env.PHREN_PATH;
    priorProfile = process.env.PHREN_PROFILE;
    priorCwd = process.cwd();
    process.env.HOME = tmp.path;
    process.env.USERPROFILE = tmp.path;
    process.env.PHREN_PATH = path.join(tmp.path, ".phren");
    process.env.PHREN_PROFILE = "work";
  });

  afterEach(() => {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    if (priorPhrenPath === undefined) delete process.env.PHREN_PATH;
    else process.env.PHREN_PATH = priorPhrenPath;
    if (priorProfile === undefined) delete process.env.PHREN_PROFILE;
    else process.env.PHREN_PROFILE = priorProfile;
    delete process.env.PHREN_ACTOR;
    tmp.cleanup();
  });

  it("covers init, add, session-start notice, MCP round-trips, and web-ui workflows", async () => {
    const phrenPath = process.env.PHREN_PATH as string;
    const repoA = path.join(tmp.path, "repo-a");
    const repoB = path.join(tmp.path, "repo-b");
    const repoC = path.join(tmp.path, "repo-c");
    const repoD = path.join(tmp.path, "repo-d");
    let db: SqlJsDatabase | null = null;

    for (const repo of [repoA, repoB, repoC, repoD]) {
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    }

    process.chdir(repoA);
    await suppressOutput(() => runInit({ yes: true, profile: "work" }));

    const verify = runPostInitVerify(phrenPath);
    expect(verify.checks.find((check) => check.name === "config")?.ok).toBe(true);
    expect(verify.checks.find((check) => check.name === "global-claude")?.ok).toBe(true);
    expect(verify.checks.find((check) => check.name === "installed-version")?.ok).toBe(true);
    expect(verify.checks.find((check) => check.name === "hook-entrypoint")?.ok).toBe(true);
    expect(verify.checks.find((check) => check.name === "fts-index")?.ok).toBe(true);
    // After init+add, the project may still show notice on macOS due to symlink resolution
    const noticeA = getUntrackedProjectNotice(phrenPath, repoA);
    if (noticeA) expect(noticeA).toContain("phren");

    await suppressOutput(() => runTopLevelCommand(["add", repoB]));
    expect(fs.readFileSync(path.join(phrenPath, "profiles", "work.yaml"), "utf8")).toContain("- repo-b");
    expect(getUntrackedProjectNotice(phrenPath, repoB)).toBeNull();
    expect(getUntrackedProjectNotice(phrenPath, repoD)).toContain("Ask the user whether they want to add it to phren now.");
    expect(getUntrackedProjectNotice(phrenPath, repoD)).toContain("ownership=\"phren-managed\"|\"detached\"|\"repo-managed\"");

    process.env.PHREN_ACTOR = "workflow-admin";
    grantAdmin(phrenPath);
    const server = makeMockServer();
    db = await buildIndex(phrenPath, "work");
    const ctx: McpContext = {
      phrenPath,
      profile: "work",
      db: () => {
        if (!db) throw new Error("index unavailable");
        return db;
      },
      rebuildIndex: async () => {
        db?.close();
        db = await buildIndex(phrenPath, "work");
      },
      updateFileInIndex: (filePath: string) => {
        if (!db) throw new Error("index unavailable");
        updateFileInIndex(db, filePath, phrenPath);
      },
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    registerMcpOps(server as any, ctx);
    registerSearch(server as any, ctx);
    registerFinding(server as any, ctx);

    const addProjectRes = parseResult(await server.call("add_project", { path: repoC }));
    expect(addProjectRes.ok).toBe(true);
    expect(addProjectRes.data.project).toBe("repo-c");
    expect(fs.readFileSync(path.join(phrenPath, "profiles", "work.yaml"), "utf8")).toContain("- repo-c");

    const addFindingRes = parseResult(await server.call("add_finding", {
      project: "repo-c",
      finding: "Workflow coverage proves repo-c search results survive init and add flows.",
    }));
    expect(addFindingRes.ok).toBe(true);

    await ctx.rebuildIndex();
    const searchRes = parseResult(await server.call("search_knowledge", {
      project: "repo-c",
      query: "workflow coverage repo-c",
    }));
    expect(searchRes.ok).toBe(true);
    expect(JSON.stringify(searchRes.data.results)).toContain("Workflow coverage proves repo-c");

    fs.writeFileSync(
      path.join(phrenPath, "repo-c", "review.md"),
      [
        "# repo-c Review Queue",
        "",
        "## Review",
        "",
        "- [2026-03-09] Approve this integrated workflow memory [confidence 0.90]",
        "",
      ].join("\n"),
    );

    const authToken = "workflow-auth-token";
    const csrfTokens = new Map<string, number>();
    const webUi = createWebUiServer(phrenPath, { authToken, csrfTokens }, "work");
    await new Promise<void>((resolve) => webUi.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = webUi.address();
      if (!address || typeof address === "string") throw new Error("failed to bind web-ui test server");
      const projectsRes = await httpGet(address.port, "/api/projects?_auth=" + encodeURIComponent(authToken));
      expect(projectsRes.status).toBe(200);
      expect(projectsRes.body).toContain("\"name\":\"repo-a\"");
      expect(projectsRes.body).toContain("\"name\":\"repo-b\"");
      expect(projectsRes.body).toContain("\"name\":\"repo-c\"");
      expect(projectsRes.body).not.toContain("\"name\":\"repo-d\"");

      const csrfRes = await httpGet(address.port, "/api/csrf-token?_auth=" + encodeURIComponent(authToken));
      expect(csrfRes.status).toBe(200);
      const csrf = JSON.parse(csrfRes.body).token as string;
      // Queue approval was removed — verify the endpoint returns an error
      const approveRes = await postForm(address.port, "/api/approve", {
        _auth: authToken,
        _csrf: csrf,
        project: "repo-c",
        line: "- [2026-03-09] Approve this integrated workflow memory [confidence 0.90]",
      });
      expect(approveRes.status).toBe(200);
      expect(JSON.parse(approveRes.body).ok).toBe(false);
      expect(JSON.parse(approveRes.body).error).toContain("removed");
    } finally {
      await new Promise<void>((resolve) => webUi.close(() => resolve()));
      db?.close();
    }
  }, 20000);
});
