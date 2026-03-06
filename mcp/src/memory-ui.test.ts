import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import * as querystring from "querystring";
import { createMemoryUiServer } from "./memory-ui.js";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function seedProject(root: string): void {
  write(
    path.join(root, "demo", "LEARNINGS.md"),
    [
      "# demo LEARNINGS",
      "",
      "## 2026-03-01",
      "",
      "- Existing learning",
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

describe.sequential("memory-ui server", () => {
  let tmpRoot = "";
  let server: http.Server | null = null;
  let port = 0;
  const priorActor = process.env.CORTEX_ACTOR;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-memory-ui-test-"));
    seedProject(tmpRoot);
    process.env.CORTEX_ACTOR = "memory-ui-admin";
    write(
      path.join(tmpRoot, ".governance", "access-control.json"),
      JSON.stringify({
        admins: ["memory-ui-admin"],
        maintainers: [],
        contributors: [],
        viewers: [],
      }, null, 2) + "\n"
    );
    server = createMemoryUiServer(tmpRoot);
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
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("supports edit/approve/reject workflow via HTTP actions", async () => {
    const oldReviewLine = "- [2026-03-05] Keep this memory [confidence 0.90]";
    const staleLine = "- [2026-03-04] Remove stale memory [confidence 0.55]";

    const editRes = await postForm(port, "/edit", {
      project: "demo",
      line: oldReviewLine,
      new_text: "keep this memory updated",
    });
    expect(editRes.status).toBe(302);

    const queueAfterEdit = fs.readFileSync(path.join(tmpRoot, "demo", "MEMORY_QUEUE.md"), "utf8");
    const editedLine = queueAfterEdit.split("\n").find((line) => line.includes("keep this memory updated"));
    expect(editedLine).toBeDefined();

    const approveRes = await postForm(port, "/approve", {
      project: "demo",
      line: editedLine || "",
    });
    expect(approveRes.status).toBe(302);

    const rejectRes = await postForm(port, "/reject", {
      project: "demo",
      line: staleLine,
    });
    expect(rejectRes.status).toBe(302);

    const queueFinal = fs.readFileSync(path.join(tmpRoot, "demo", "MEMORY_QUEUE.md"), "utf8");
    expect(queueFinal).not.toContain("keep this memory updated");
    expect(queueFinal).not.toContain("Remove stale memory");

    const learnings = fs.readFileSync(path.join(tmpRoot, "demo", "LEARNINGS.md"), "utf8");
    expect(learnings).toContain("keep this memory updated");
  });

  it("returns 403 when contributor tries to approve risky queue item", async () => {
    process.env.CORTEX_ACTOR = "memory-ui-contributor";
    write(
      path.join(tmpRoot, ".governance", "access-control.json"),
      JSON.stringify({
        admins: [],
        maintainers: [],
        contributors: ["memory-ui-contributor"],
        viewers: [],
      }, null, 2) + "\n"
    );
    const staleLine = "- [2026-03-04] Remove stale memory [confidence 0.55]";

    const res = await postForm(port, "/approve", {
      project: "demo",
      line: staleLine,
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("maintainer/admin role");
  });

  it("returns 400 for empty edit text", async () => {
    const line = "- [2026-03-05] Keep this memory [confidence 0.90]";
    const res = await postForm(port, "/edit", {
      project: "demo",
      line,
      new_text: "   ",
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("cannot be empty");
  });
});
