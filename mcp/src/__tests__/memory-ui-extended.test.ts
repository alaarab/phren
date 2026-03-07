import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFile as write, makeTempDir, grantAdmin } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
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

  it("auth token is embedded in GET / page HTML", async () => {
    const res = await httpGet(port, "/");
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
    // Raw <script> tags should be escaped
    expect(res.body).not.toContain('<script>alert("xss")</script>');
    expect(res.body).toContain("&lt;script&gt;");
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
    await httpGet(port, "/");
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
    await httpGet(port, "/");
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
    expect(res.body).toContain("Cortex Memory Review");
    expect(res.body).toContain("Review");
    expect(res.body).toContain("Graph");
    expect(res.body).toContain("Approve");
    expect(res.body).toContain("Reject");
    expect(res.body).toContain("Edit");
  });

  it("GET / page shows no items when queue is empty", async () => {
    // Remove the queue file
    fs.unlinkSync(path.join(tmpRoot, "demo", "MEMORY_QUEUE.md"));
    const res = await httpGet(port, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("No queued items");
  });
});
