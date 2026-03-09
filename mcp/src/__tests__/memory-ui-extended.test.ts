import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFile as write, makeTempDir, grantAdmin } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as os from "os";
import * as querystring from "querystring";
import { createReviewUiServer } from "../memory-ui.js";

function seedProject(root: string): void {
  write(
    path.join(root, "demo", "FINDINGS.md"),
    [
      "# demo FINDINGS",
      "",
      "## 2026-03-01",
      "",
      "- [decision] Use WAL mode for SQLite",
      "- [pitfall] Do not use synchronous writes in hooks",
      "- [pattern] Always validate project names before path resolution",
      "",
    ].join("\n")
  );
  write(
    path.join(root, "demo", "MEMORY_QUEUE.md"),
    [
      "# demo Memory Queue",
      "",
      "## Review",
      "",
      "- [2026-03-05] Keep this memory [confidence 0.90]",
      "- [2026-03-06] Another review item [confidence 0.80]",
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

function seedSecondProject(root: string): void {
  write(
    path.join(root, "other", "FINDINGS.md"),
    [
      "# other FINDINGS",
      "",
      "## 2026-03-02",
      "",
      "- [pattern] Batch writes improve throughput",
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
          resolve({ status: res.statusCode || 0, body: out, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let out = "";
      res.on("data", (chunk) => { out += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode || 0, body: out }));
    }).on("error", reject);
  });
}

describe.sequential("review-ui auth token protection", () => {
  let tmpRoot = "";
  let tmpCleanup: () => void;
  let server: http.Server | null = null;
  let port = 0;
  let authToken: string;
  const priorActor = process.env.CORTEX_ACTOR;

  beforeEach(async () => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-review-ui-auth-"));
    seedProject(tmpRoot);
    process.env.CORTEX_ACTOR = "review-ui-admin";
    grantAdmin(tmpRoot);
    authToken = "test-auth-token-secret";
    server = createReviewUiServer(tmpRoot, { authToken });
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
    if (priorActor === undefined) delete process.env.CORTEX_ACTOR;
    else process.env.CORTEX_ACTOR = priorActor;
    tmpCleanup();
  });

  it("returns 401 when auth token is missing from POST", async () => {
    const res = await postForm(port, "/approve", {
      project: "demo",
      line: "- [2026-03-05] Keep this memory [confidence 0.90]",
    });
    expect(res.status).toBe(401);
    expect(res.body).toContain("Unauthorized");
  });

  it("returns 401 when auth token is wrong", async () => {
    const res = await postForm(port, "/approve", {
      _auth: "wrong-token",
      project: "demo",
      line: "- [2026-03-05] Keep this memory [confidence 0.90]",
    });
    expect(res.status).toBe(401);
    expect(res.body).toContain("Unauthorized");
  });

  it("succeeds with correct auth token", async () => {
    const res = await postForm(port, "/approve", {
      _auth: authToken,
      project: "demo",
      line: "- [2026-03-05] Keep this memory [confidence 0.90]",
    });
    expect(res.status).toBe(302);
  });

  it("GET / returns 401 without auth token", async () => {
    const res = await httpGet(port, "/");
    expect(res.status).toBe(401);
    expect(res.body).toContain("Unauthorized");
  });

  it("GET / requires auth and only embeds token after successful auth", async () => {
    const res = await httpGet(port, "/?_auth=" + encodeURIComponent(authToken));
    expect(res.status).toBe(200);
    expect(res.body).toContain(authToken);
  });
});

describe.sequential("review-ui graph API", () => {
  let tmpRoot = "";
  let tmpCleanup: () => void;
  let server: http.Server | null = null;
  let port = 0;
  const priorActor = process.env.CORTEX_ACTOR;

  beforeEach(async () => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-review-ui-graph-"));
    seedProject(tmpRoot);
    seedSecondProject(tmpRoot);
    process.env.CORTEX_ACTOR = "review-ui-admin";
    grantAdmin(tmpRoot);
    server = createReviewUiServer(tmpRoot);
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
    if (priorActor === undefined) delete process.env.CORTEX_ACTOR;
    else process.env.CORTEX_ACTOR = priorActor;
    tmpCleanup();
  });

  it("GET /api/graph returns valid JSON with nodes and links", async () => {
    const res = await httpGet(port, "/api/graph");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty("nodes");
    expect(data).toHaveProperty("links");
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.links)).toBe(true);
  });

  it("graph nodes include project nodes and finding nodes", async () => {
    const res = await httpGet(port, "/api/graph");
    const data = JSON.parse(res.body);
    const projectNodes = data.nodes.filter((n: any) => n.group === "project");
    expect(projectNodes.length).toBeGreaterThanOrEqual(2);
    const projectNames = projectNodes.map((n: any) => n.label);
    expect(projectNames).toContain("demo");
    expect(projectNames).toContain("other");
  });

  it("graph nodes have correct group types", async () => {
    const res = await httpGet(port, "/api/graph");
    const data = JSON.parse(res.body);
    const groups = new Set(data.nodes.map((n: any) => n.group));
    expect(groups.has("project")).toBe(true);
    // demo has decision, pitfall, and pattern findings
    expect(groups.has("decision")).toBe(true);
    expect(groups.has("pitfall")).toBe(true);
    expect(groups.has("pattern")).toBe(true);
  });

  it("graph links connect project to its findings", async () => {
    const res = await httpGet(port, "/api/graph");
    const data = JSON.parse(res.body);
    const demoLinks = data.links.filter((l: any) => l.source === "demo");
    // demo has 3 tagged findings
    expect(demoLinks.length).toBe(3);
  });

  it("graph truncates long finding labels to 60 chars", async () => {
    // Add a very long finding
    write(
      path.join(tmpRoot, "demo", "FINDINGS.md"),
      [
        "# demo FINDINGS",
        "",
        "## 2026-03-01",
        "",
        `- [decision] ${"A".repeat(80)}`,
        "",
      ].join("\n")
    );
    const res = await httpGet(port, "/api/graph");
    const data = JSON.parse(res.body);
    const decisionNodes = data.nodes.filter((n: any) => n.group === "decision");
    for (const node of decisionNodes) {
      expect(node.label.length).toBeLessThanOrEqual(60);
    }
  });

  it("lifts graph caps for a focused project without changing the default graph", async () => {
    const findings = [
      "# demo FINDINGS",
      "",
      "## 2026-03-01",
      "",
      ...Array.from({ length: 205 }, (_, index) => `- [pattern] Focused tagged finding ${index + 1}`),
      ...Array.from({ length: 105 }, (_, index) => `- Focused plain finding entry ${index + 1} with enough words`),
      "",
    ].join("\n");
    write(path.join(tmpRoot, "demo", "FINDINGS.md"), findings);

    const defaultRes = await httpGet(port, "/api/graph");
    expect(defaultRes.status).toBe(200);
    const defaultData = JSON.parse(defaultRes.body);
    const defaultDemoNodes = defaultData.nodes.filter((n: any) => String(n.id).startsWith("demo:"));
    expect(defaultDemoNodes).toHaveLength(300);

    const focusedRes = await httpGet(port, "/api/graph?project=demo");
    expect(focusedRes.status).toBe(200);
    const focusedData = JSON.parse(focusedRes.body);
    const focusedDemoNodes = focusedData.nodes.filter((n: any) => String(n.id).startsWith("demo:"));
    expect(focusedDemoNodes).toHaveLength(310);
  });
});

describe.sequential("review-ui profile scoping", () => {
  let tmpRoot = "";
  let tmpCleanup: () => void;
  let server: http.Server | null = null;
  let port = 0;
  const priorHome = process.env.HOME;
  const priorUserProfile = process.env.USERPROFILE;

  beforeEach(async () => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-review-ui-profile-"));
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;
    seedProject(tmpRoot);
    seedSecondProject(tmpRoot);
    write(path.join(tmpRoot, "profiles", "work.yaml"), "name: work\nprojects:\n  - demo\n");
    server = createReviewUiServer(tmpRoot, undefined, "work");
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
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    tmpCleanup();
  });

  it("limits project and graph APIs to the active profile", async () => {
    const projectsRes = await httpGet(port, "/api/projects");
    expect(projectsRes.status).toBe(200);
    expect(projectsRes.body).toContain("\"name\":\"demo\"");
    expect(projectsRes.body).not.toContain("\"name\":\"other\"");

    const graphRes = await httpGet(port, "/api/graph");
    expect(graphRes.status).toBe(200);
    expect(graphRes.body).toContain("\"id\":\"demo\"");
    expect(graphRes.body).not.toContain("\"id\":\"other\"");
  });
});

describe.sequential("review-ui HTML escaping", () => {
  let tmpRoot = "";
  let tmpCleanup: () => void;
  let server: http.Server | null = null;
  let port = 0;
  const priorActor = process.env.CORTEX_ACTOR;

  beforeEach(async () => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-review-ui-xss-"));
    process.env.CORTEX_ACTOR = "review-ui-admin";
    grantAdmin(tmpRoot);
    // Seed with XSS-like content in queue
    write(
      path.join(tmpRoot, "xss-test", "FINDINGS.md"),
      "# xss-test FINDINGS\n"
    );
    write(
      path.join(tmpRoot, "xss-test", "MEMORY_QUEUE.md"),
      [
        "# xss-test Memory Queue",
        "",
        "## Review",
        "",
        '- [2026-03-05] <script>alert("xss")</script> [confidence 0.90]',
        "",
        "## Stale",
        "",
        "## Conflicts",
        "",
      ].join("\n")
    );
    server = createReviewUiServer(tmpRoot);
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
    if (priorActor === undefined) delete process.env.CORTEX_ACTOR;
    else process.env.CORTEX_ACTOR = priorActor;
    tmpCleanup();
  });

  it("HTML-escapes XSS payloads in queue items", async () => {
    const res = await httpGet(port, "/");
    expect(res.status).toBe(200);
    // Queue items are now rendered client-side: raw <script> tags must not appear in the initial HTML
    expect(res.body).not.toContain('<script>alert("xss")</script>');
    // The /api/review-queue endpoint returns raw JSON (client-side esc() handles XSS on render)
    const apiRes = await httpGet(port, "/api/review-queue");
    expect(apiRes.status).toBe(200);
    const items = JSON.parse(apiRes.body) as Array<{ text: string }>;
    expect(items.length).toBeGreaterThan(0);
    // JSON text field is raw (not HTML-escaped) — protection happens client-side
    expect(items[0].text).toContain('<script>alert("xss")</script>');
  });
});

describe.sequential("review-ui combined CSRF + auth", () => {
  let tmpRoot = "";
  let tmpCleanup: () => void;
  let server: http.Server | null = null;
  let port = 0;
  let csrfTokens: Map<string, number>;
  let authToken: string;
  const priorActor = process.env.CORTEX_ACTOR;

  beforeEach(async () => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-csrf-auth-"));
    seedProject(tmpRoot);
    process.env.CORTEX_ACTOR = "review-ui-admin";
    grantAdmin(tmpRoot);
    csrfTokens = new Map<string, number>();
    authToken = "combined-auth-token";
    server = createReviewUiServer(tmpRoot, { authToken, csrfTokens });
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
    if (priorActor === undefined) delete process.env.CORTEX_ACTOR;
    else process.env.CORTEX_ACTOR = priorActor;
    tmpCleanup();
  });

  it("requires both auth and CSRF for POST to succeed", async () => {
    // Get CSRF token
    await httpGet(port, "/?_auth=" + encodeURIComponent(authToken));
    const token = [...csrfTokens.keys()][0];

    // Missing auth -> 401
    const noAuth = await postForm(port, "/reject", {
      _csrf: token,
      project: "demo",
      line: "- [2026-03-04] Remove stale memory [confidence 0.55]",
    });
    expect(noAuth.status).toBe(401);
  });

  it("rejects when auth is correct but CSRF is missing", async () => {
    const res = await postForm(port, "/approve", {
      _auth: authToken,
      project: "demo",
      line: "- [2026-03-05] Keep this memory [confidence 0.90]",
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("CSRF");
  });

  it("succeeds when both auth and CSRF are correct", async () => {
    await httpGet(port, "/?_auth=" + encodeURIComponent(authToken));
    const token = [...csrfTokens.keys()][0];
    const res = await postForm(port, "/approve", {
      _auth: authToken,
      _csrf: token,
      project: "demo",
      line: "- [2026-03-05] Keep this memory [confidence 0.90]",
    });
    expect(res.status).toBe(302);
  });
});

describe.sequential("review-ui missing project/line validation", () => {
  let tmpRoot = "";
  let tmpCleanup: () => void;
  let server: http.Server | null = null;
  let port = 0;
  const priorActor = process.env.CORTEX_ACTOR;

  beforeEach(async () => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-review-ui-val-"));
    seedProject(tmpRoot);
    process.env.CORTEX_ACTOR = "review-ui-admin";
    grantAdmin(tmpRoot);
    server = createReviewUiServer(tmpRoot);
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
    if (priorActor === undefined) delete process.env.CORTEX_ACTOR;
    else process.env.CORTEX_ACTOR = priorActor;
    tmpCleanup();
  });

  it("returns 400 when project is missing", async () => {
    const res = await postForm(port, "/approve", {
      line: "- [2026-03-05] something",
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("Missing project/line");
  });

  it("returns 400 when line is missing", async () => {
    const res = await postForm(port, "/approve", {
      project: "demo",
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("Missing project/line");
  });

  it("returns 404 for POST to unknown route", async () => {
    const res = await postForm(port, "/unknown-action", {
      project: "demo",
      line: "anything",
    });
    expect(res.status).toBe(404);
  });

  it("GET / page contains expected UI elements", async () => {
    const res = await httpGet(port, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Cortex Dashboard");
    expect(res.body).toContain("Review");
    expect(res.body).toContain("Graph");
    expect(res.body).toContain("Approve");
    expect(res.body).toContain("Reject");
  });

  it("GET / page shows no items when queue is empty", async () => {
    // Remove the queue file
    fs.unlinkSync(path.join(tmpRoot, "demo", "MEMORY_QUEUE.md"));
    const res = await httpGet(port, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("No memories waiting for review");
  });
});

describe.sequential("review-ui skill-save auth protection (Q13)", () => {
  let tmpRoot = "";
  let tmpCleanup: () => void;
  let server: http.Server | null = null;
  let port = 0;
  let authToken: string;
  const priorActor = process.env.CORTEX_ACTOR;

  beforeEach(async () => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-skill-auth-"));
    seedProject(tmpRoot);
    process.env.CORTEX_ACTOR = "review-ui-admin";
    grantAdmin(tmpRoot);
    authToken = "skill-auth-token";
    server = createReviewUiServer(tmpRoot, { authToken });
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
    if (priorActor === undefined) delete process.env.CORTEX_ACTOR;
    else process.env.CORTEX_ACTOR = priorActor;
    tmpCleanup();
  });

  it("POST /api/skill-save returns 401 without auth token", async () => {
    const skillPath = path.join(tmpRoot, "global", "skills", "test-skill.md");
    const res = await postForm(port, "/api/skill-save", {
      path: skillPath,
      content: "# Test skill",
    });
    expect(res.status).toBe(401);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Unauthorized");
  });

  it("POST /api/skill-save returns 401 with wrong auth token", async () => {
    const skillPath = path.join(tmpRoot, "global", "skills", "test-skill.md");
    const res = await postForm(port, "/api/skill-save", {
      _auth: "wrong-token",
      path: skillPath,
      content: "# Test skill",
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/skill-save succeeds with correct auth token", async () => {
    const skillPath = path.join(tmpRoot, "global", "skills", "test-skill.md");
    const res = await postForm(port, "/api/skill-save", {
      _auth: authToken,
      path: skillPath,
      content: "# Test skill",
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
  });

  it("GET /api/skills returns 401 without auth token", async () => {
    const res = await httpGet(port, "/api/skills");
    expect(res.status).toBe(401);
  });

  it("GET /api/skills succeeds with auth token in query", async () => {
    const res = await httpGet(port, "/api/skills?_auth=" + encodeURIComponent(authToken));
    expect(res.status).toBe(200);
  });

  it("POST /api/skill-save rejects symlink traversal for new files", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-skill-escape-"));
    const linkRoot = path.join(tmpRoot, "global", "skills", "escape");
    fs.mkdirSync(path.dirname(linkRoot), { recursive: true });
    fs.symlinkSync(outsideDir, linkRoot, "dir");

    const csrfRes = await httpGet(port, "/api/csrf-token?_auth=" + encodeURIComponent(authToken));
    expect(csrfRes.status).toBe(200);
    const csrf = JSON.parse(csrfRes.body).csrfToken as string;
    const escapedPath = path.join(linkRoot, "pwned.md");

    const res = await postForm(port, "/api/skill-save", {
      _auth: authToken,
      _csrf: csrf,
      path: escapedPath,
      content: "# should not write",
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid path");
    expect(fs.existsSync(path.join(outsideDir, "pwned.md"))).toBe(false);
  });
});

describe.sequential("review-ui hook-toggle auth protection (Q13)", () => {
  let tmpRoot = "";
  let tmpCleanup: () => void;
  let server: http.Server | null = null;
  let port = 0;
  let authToken: string;
  const priorActor = process.env.CORTEX_ACTOR;

  beforeEach(async () => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-hook-auth-"));
    seedProject(tmpRoot);
    process.env.CORTEX_ACTOR = "review-ui-admin";
    grantAdmin(tmpRoot);
    authToken = "hook-auth-token";
    server = createReviewUiServer(tmpRoot, { authToken });
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
    if (priorActor === undefined) delete process.env.CORTEX_ACTOR;
    else process.env.CORTEX_ACTOR = priorActor;
    tmpCleanup();
  });

  it("POST /api/hook-toggle returns 401 without auth token", async () => {
    const res = await postForm(port, "/api/hook-toggle", {
      tool: "claude",
    });
    expect(res.status).toBe(401);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Unauthorized");
  });

  it("POST /api/hook-toggle returns 401 with wrong auth token", async () => {
    const res = await postForm(port, "/api/hook-toggle", {
      _auth: "wrong-token",
      tool: "claude",
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/hook-toggle succeeds with correct auth token", async () => {
    const res = await postForm(port, "/api/hook-toggle", {
      _auth: authToken,
      tool: "claude",
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
  });
});

describe.sequential("review-ui JSON API auth for approve/reject/edit (Q13)", () => {
  let tmpRoot = "";
  let tmpCleanup: () => void;
  let server: http.Server | null = null;
  let port = 0;
  let authToken: string;
  const priorActor = process.env.CORTEX_ACTOR;

  beforeEach(async () => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-json-api-auth-"));
    seedProject(tmpRoot);
    process.env.CORTEX_ACTOR = "review-ui-admin";
    grantAdmin(tmpRoot);
    authToken = "json-api-auth-token";
    server = createReviewUiServer(tmpRoot, { authToken });
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
    if (priorActor === undefined) delete process.env.CORTEX_ACTOR;
    else process.env.CORTEX_ACTOR = priorActor;
    tmpCleanup();
  });

  it("POST /api/approve returns 401 without auth", async () => {
    const res = await postForm(port, "/api/approve", {
      project: "demo",
      line: "- [2026-03-05] Keep this memory [confidence 0.90]",
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/reject returns 401 without auth", async () => {
    const res = await postForm(port, "/api/reject", {
      project: "demo",
      line: "- [2026-03-04] Remove stale memory [confidence 0.55]",
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/edit returns 401 without auth", async () => {
    const res = await postForm(port, "/api/edit", {
      project: "demo",
      line: "- [2026-03-05] Keep this memory [confidence 0.90]",
      new_text: "updated text",
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/approve succeeds with correct auth", async () => {
    const res = await postForm(port, "/api/approve", {
      _auth: authToken,
      project: "demo",
      line: "- [2026-03-05] Keep this memory [confidence 0.90]",
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
  });
});
