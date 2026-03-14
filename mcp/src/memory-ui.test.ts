import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFile as write, makeTempDir } from "./test-helpers.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import * as querystring from "querystring";
import { createWebUiServer, renderPageForTests } from "./memory-ui.js";
import { getWebUiBrowserCommand, waitForWebUiReady } from "./memory-ui-server.js";

function seedProject(root: string): void {
  write(
    path.join(root, "demo", "FINDINGS.md"),
    [
      "# demo FINDINGS",
      "",
      "## 2026-03-01",
      "",
      "- Existing finding",
      "",
    ].join("\n")
  );
  write(
    path.join(root, "demo", "review.md"),
    [
      "# demo Review Queue",
      "",
      "## Review",
      "",
      "- [2026-03-05] Keep this memory [confidence 0.90]",
      "",
      "## Stale",
      "",
      "- [2026-03-04] Remove stale memory [confidence 0.55]",
      "",
      "## Conflicts",
      "",
      "",
    ].join("\n")
  );
}

async function postForm(
  port: number,
  route: string,
  body: Record<string, string>
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const payload = querystring.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "POST",
        host: "127.0.0.1",
        port,
        path: route,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (chunk) => { out += String(chunk); });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            body: out,
            headers: res.headers,
          });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe.sequential("web-ui server", () => {
  let tmpRoot = "";
  let tmpCleanup: () => void;
  let server: http.Server | null = null;
  let port = 0;
  const priorActor = process.env.PHREN_ACTOR;

  beforeEach(async () => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("phren-web-ui-test-"));
    seedProject(tmpRoot);
    process.env.PHREN_ACTOR = "web-ui-admin";
    write(
      path.join(tmpRoot, ".governance", "access-control.json"),
      JSON.stringify({
        admins: ["web-ui-admin"],
        maintainers: [],
        contributors: [],
        viewers: [],
      }, null, 2) + "\n"
    );
    server = createWebUiServer(tmpRoot);
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind test server");
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    server = null;
    if (priorActor === undefined) delete process.env.PHREN_ACTOR;
    else process.env.PHREN_ACTOR = priorActor;
    tmpCleanup();
  });

  it("queue operations return error since they were removed", async () => {
    const reviewLine = "- [2026-03-05] Keep this memory [confidence 0.90]";

    const approveRes = await postForm(port, "/approve", {
      project: "demo",
      line: reviewLine,
    });
    expect(approveRes.status).toBe(500);
    expect(approveRes.body).toContain("removed");

    const rejectRes = await postForm(port, "/reject", {
      project: "demo",
      line: reviewLine,
    });
    expect(rejectRes.status).toBe(500);
    expect(rejectRes.body).toContain("removed");

    const editRes = await postForm(port, "/edit", {
      project: "demo",
      line: reviewLine,
      new_text: "updated",
    });
    expect(editRes.status).toBe(500);
    expect(editRes.body).toContain("removed");
  });

  it("returns 400 for invalid project name", async () => {
    const res = await postForm(port, "/approve", {
      project: "../escape",
      line: "- [2026-03-05] anything",
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("Invalid project name");
  });

  it("returns 404 for unknown GET route", async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/unknown`, (res) => {
        let out = "";
        res.on("data", (chunk) => { out += String(chunk); });
        res.on("end", () => resolve({ status: res.statusCode || 0, body: out }));
      }).on("error", reject);
    });
    expect(res.status).toBe(404);
    expect(res.body).toBe("Not found");
  });

  it("change token updates when project content changes", async () => {
    const readToken = async (): Promise<string> => {
      return await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/api/change-token`, (res) => {
          let out = "";
          res.on("data", (chunk) => { out += String(chunk); });
          res.on("end", () => resolve(JSON.parse(out).token));
        }).on("error", reject);
      });
    };

    const before = await readToken();
    fs.appendFileSync(path.join(tmpRoot, "demo", "tasks.md"), "\n- [ ] Live refresh item\n");
    const after = await readToken();
    expect(after).not.toBe(before);
  });

  it("lists shared hook config paths for Claude and Codex", async () => {
    const origHome = process.env.HOME;
    const origProfile = process.env.USERPROFILE;
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;
    fs.mkdirSync(path.join(tmpRoot, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, ".claude", "settings.json"), JSON.stringify({ hooks: {} }, null, 2));
    fs.writeFileSync(path.join(tmpRoot, "codex.json"), JSON.stringify({ hooks: {} }, null, 2));

    try {
      const body = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/api/hooks`, (res) => {
          let out = "";
          res.on("data", (chunk) => { out += String(chunk); });
          res.on("end", () => resolve(out));
        }).on("error", reject);
      });

      const parsed = JSON.parse(body) as {
        tools: Array<{ tool: string; configPath: string; exists: boolean }>;
      };
      const claude = parsed.tools.find((tool) => tool.tool === "claude");
      const codex = parsed.tools.find((tool) => tool.tool === "codex");

      expect(claude?.configPath).toBe(path.join(tmpRoot, ".claude", "settings.json"));
      expect(claude?.exists).toBe(true);
      expect(codex?.configPath).toBe(path.join(tmpRoot, "codex.json"));
      expect(codex?.exists).toBe(true);
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origProfile;
    }
  });

  it("returns 413 for request body exceeding 1MB", async () => {
    const bigPayload = querystring.stringify({
      project: "demo",
      line: "x".repeat(1_100_000),
    });
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          method: "POST",
          host: "127.0.0.1",
          port,
          path: "/approve",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "content-length": Buffer.byteLength(bigPayload),
          },
        },
        (res) => {
          let out = "";
          res.on("data", (chunk) => { out += String(chunk); });
          res.on("end", () => resolve({ status: res.statusCode || 0, body: out }));
        }
      );
      req.on("error", () => resolve({ status: 413, body: "connection destroyed" }));
      req.write(bigPayload);
      req.end();
    });
    expect(res.status).toBe(413);
  });
});

describe.sequential("web-ui CSRF protection", () => {
  let tmpRoot = "";
  let tmpCleanup: () => void;
  let server: http.Server | null = null;
  let port = 0;
  let csrfTokens: Map<string, number>;
  const priorActor = process.env.PHREN_ACTOR;

  beforeEach(async () => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("phren-csrf-test-"));
    seedProject(tmpRoot);
    process.env.PHREN_ACTOR = "web-ui-admin";
    write(
      path.join(tmpRoot, ".governance", "access-control.json"),
      JSON.stringify({
        admins: ["web-ui-admin"],
        maintainers: [],
        contributors: [],
        viewers: [],
      }, null, 2) + "\n"
    );
    csrfTokens = new Map<string, number>();
    server = createWebUiServer(tmpRoot, { csrfTokens });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind test server");
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    server = null;
    if (priorActor === undefined) delete process.env.PHREN_ACTOR;
    else process.env.PHREN_ACTOR = priorActor;
    tmpCleanup();
  });

  it("GET / returns HTML with a CSRF token embedded", async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let out = "";
        res.on("data", (chunk) => { out += String(chunk); });
        res.on("end", () => resolve({ status: res.statusCode || 0, body: out }));
      }).on("error", reject);
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("_csrf");
    expect(csrfTokens.size).toBe(1);
  });

  it("POST /api/hook-toggle with valid CSRF token succeeds", async () => {
    // Get a CSRF token first
    await new Promise<void>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        res.on("end", () => resolve());
      }).on("error", reject);
    });
    const token = [...csrfTokens.keys()][0];

    const res = await postForm(port, "/api/hook-toggle", {
      _csrf: token,
      tool: "claude",
      enabled: "true",
    });
    expect(res.status).toBe(200);
  });

  it("POST /approve without CSRF token returns 403", async () => {
    const res = await postForm(port, "/approve", {
      project: "demo",
      line: "- [2026-03-05] Keep this memory [confidence 0.90]",
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("CSRF");
  });

  it("POST /approve with invalid CSRF token returns 403", async () => {
    const res = await postForm(port, "/approve", {
      _csrf: "bogus-token",
      project: "demo",
      line: "- [2026-03-05] Keep this memory [confidence 0.90]",
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("CSRF");
  });

  it("CSRF token is single-use", async () => {
    await new Promise<void>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        res.on("end", () => resolve());
      }).on("error", reject);
    });
    const token = [...csrfTokens.keys()][0];

    // First use succeeds
    const first = await postForm(port, "/api/hook-toggle", {
      _csrf: token,
      tool: "claude",
      enabled: "true",
    });
    expect(first.status).toBe(200);

    // Replay with same token fails
    const replay = await postForm(port, "/api/hook-toggle", {
      _csrf: token,
      tool: "claude",
      enabled: "true",
    });
    expect(replay.status).toBe(403);
  });
});

describe("web-ui HTML rendering", () => {
  it("uses element-based handlers for skills and hooks instead of inline quoted values", () => {
    const { path: tmpRoot, cleanup } = makeTempDir("phren-web-ui-html-");
    try {
      seedProject(tmpRoot);
      const body = renderPageForTests(tmpRoot, "csrf-token");
      expect(body).toContain('data-ui-action="selectSkillFromEl"');
      expect(body).toContain('data-ui-action="selectHookFromEl"');
      expect(body).toContain('data-ui-action="toggleHookToolFromEl"');
      expect(body).not.toContain('JSON.stringify(s.path).replace(/"/g, "\'")');
      expect(body).not.toContain('JSON.stringify(t.configPath).replace(/"/g,"\'")');
      expect(body).not.toContain('JSON.stringify(toolName).replace(/"/g,"\'")');
    } finally {
      cleanup();
    }
  });

  it("uses safe review-queue handlers and escaped plain-text rendering for queue items", () => {
    const { path: tmpRoot, cleanup } = makeTempDir("phren-web-ui-review-html-");
    try {
      seedProject(tmpRoot);
      const body = renderPageForTests(tmpRoot, "csrf-token");
      expect(body).toContain("window.reviewActionFromEl = function(btn, action)");
      expect(body).toContain("window.reviewEditSubmitFromEl = function(e, form)");
      expect(body).toContain('data-ui-action="reviewAction" data-review-type="approve"');
      expect(body).toContain('data-ui-action="reviewAction" data-review-type="reject"');
      expect(body).toContain('data-ui-action="reviewEditSubmit"');
      expect(body).toContain("var cardText = esc(item.text);");
      expect(body).toContain("'<div class=\"review-card-text\">' + cardText + '</div>'");
      expect(body).toContain("textEl.innerHTML = esc(newText).replace(/\\n/g, '<br>');");
      expect(body).not.toContain("marked.parse(item.text)");
      expect(body).not.toContain("JSON.stringify(item.line)");
    } finally {
      cleanup();
    }
  });

  it("renders graph detail scaffolding and enhanced graph controls", () => {
    const { path: tmpRoot, cleanup } = makeTempDir("phren-web-ui-graph-html-");
    try {
      seedProject(tmpRoot);
      const body = renderPageForTests(tmpRoot, "csrf-token");
      expect(body).toContain('id="graph-detail-panel"');
      expect(body).toContain('id="graph-detail-body"');
      expect(body).toContain("phrenGraph");
      expect(body).toContain("window.graphClearSelection");
    } finally {
      cleanup();
    }
  });
});

describe("web-ui launch helpers", () => {
  it("builds browser launch commands for each supported platform", () => {
    expect(getWebUiBrowserCommand("http://127.0.0.1:3499", "darwin")).toEqual({
      command: "open",
      args: ["http://127.0.0.1:3499"],
    });
    expect(getWebUiBrowserCommand("http://127.0.0.1:3499", "win32")).toEqual({
      command: process.env.ComSpec || "cmd.exe",
      args: ["/c", "start", "", "http://127.0.0.1:3499"],
    });
    expect(getWebUiBrowserCommand("http://127.0.0.1:3499", "linux")).toEqual({
      command: "xdg-open",
      args: ["http://127.0.0.1:3499"],
    });
  });

  it("waits for the web-ui server to answer before launch", async () => {
    const { path: tmpRoot, cleanup } = makeTempDir("phren-web-ui-ready-");
    const server = createWebUiServer(tmpRoot);
    seedProject(tmpRoot);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("failed to bind test server");
      const ready = await waitForWebUiReady(`http://127.0.0.1:${address.port}/`);
      expect(ready).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup();
    }
  });
});
