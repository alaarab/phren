import { dump, load } from "js-yaml";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Computer, HookRequest, HookResponse } from "./contract.js";
import { blobSha, createMemoryService } from "./memory.js";

const B: Computer = { name: "B", local: false, address: "b", username: "me", port: 22, hostKey: "k", server: "default", keyFile: "/k" };

const REVIEW_TEXT = "# proj-a Review\n\n## Review\n\n- pending item\n";

function json(body: unknown): HookResponse {
  return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)) };
}

interface FakeStore {
  request: HookRequest;
  posts: Array<{ path: string; content: string; sha: string | null }>;
  calls: { head: number; tree: number; blob: number; file: number; blobs: number };
  change(next: Record<string, string | null>): void;
}

/** A Hook serving head/tree/blob/file over a mutable in-memory store. */
function fakeStore(initial: Record<string, string>, { batch = false, extraTree = [] as Array<Record<string, unknown>> } = {}): FakeStore {
  const files = new Map<string, Buffer>();
  for (const [p, text] of Object.entries(initial)) files.set(p, Buffer.from(text));
  const posts: FakeStore["posts"] = [];
  const calls = { head: 0, tree: 0, blob: 0, file: 0, blobs: 0 };
  let head = "1".repeat(40);
  const bump = (token: string) => { head = blobSha(Buffer.from(`${head}:${token}`)); };

  const request: HookRequest = async (_c, method, requestPath, body) => {
    const url = new URL(requestPath, "http://hook");
    if (method === "GET" && url.pathname === "/v1/store/head") {
      calls.head += 1;
      return json({ sha: head });
    }
    if (method === "GET" && url.pathname === "/v1/store/tree") {
      calls.tree += 1;
      const tree = [...files.entries()].map(([p, buf]) => ({ path: p, type: "blob", sha: blobSha(buf), size: buf.length } as Record<string, unknown>)).concat(extraTree);
      return json({ sha: head, truncated: false, tree });
    }
    if (method === "GET" && url.pathname === "/v1/store/blob") {
      calls.blob += 1;
      const sha = url.searchParams.get("sha") ?? "";
      const buf = [...files.values()].find((value) => blobSha(value) === sha);
      if (!buf) return { status: 404, headers: {}, body: Buffer.from("{}") };
      return json({ sha, encoding: "base64", content: buf.toString("base64") });
    }
    if (batch && method === "POST" && url.pathname === "/v1/store/blobs") {
      calls.blobs += 1;
      const shas = (body as { shas: string[] }).shas;
      return json({ blobs: shas.map((sha) => {
        const buf = [...files.values()].find((value) => blobSha(value) === sha);
        return buf ? { sha, encoding: "base64", content: buf.toString("base64") } : { sha, error: "unknown" };
      }) });
    }
    if (method === "POST" && url.pathname === "/v1/store/file") {
      calls.file += 1;
      const data = body as { path: string; content: string; sha: string | null };
      posts.push(data);
      const current = files.get(data.path);
      if ((current ? blobSha(current) : null) !== (data.sha ?? null)) {
        return { status: 409, headers: {}, body: Buffer.from(JSON.stringify({ error: "changed" })) };
      }
      const content = Buffer.from(data.content, "base64");
      files.set(data.path, content);
      bump(data.path);
      return json({ content: { sha: blobSha(content), path: data.path }, commit: { sha: blobSha(content) } });
    }
    return { status: 404, headers: {}, body: Buffer.from("{}") };
  };

  return {
    request,
    posts,
    calls,
    change(next) {
      for (const [p, text] of Object.entries(next)) {
        if (text === null) files.delete(p);
        else files.set(p, Buffer.from(text));
        bump(p);
      }
    },
  };
}

let dir: string;
let home: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "desktop-memory-"));
  home = path.join(dir, "home");
  await rm(home, { recursive: true, force: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function service(store: FakeStore, cacheDir = path.join(dir, "cache")) {
  return createMemoryService({ hookRequest: store.request, computers: [B], cacheDir, home, syncMs: 0 });
}

describe("remote mirror", () => {
  it("lays out the memory files and counts the projects", async () => {
    const store = fakeStore({
      "proj-a/FINDINGS.md": "# Findings\n\n- alpha\n",
      "proj-a/review.md": REVIEW_TEXT,
      "proj-b/tasks.md": "# tasks\n\n## Queue\n\n- do a thing\n",
      "proj-a/README.md": "not a memory file\n",
      "phren.root.yaml": "version: 1\ninstallMode: shared\n",
      "stores.yaml": "version: 1\n",
    });
    const cacheDir = path.join(dir, "cache");

    const { projects } = await service(store, cacheDir).projects(B);

    expect(projects.map((p) => p.name)).toEqual(["proj-a", "proj-b"]);
    expect(projects.find((p) => p.name === "proj-a")).toMatchObject({ findings: 1, review: 1 });
    expect(projects.find((p) => p.name === "proj-b")).toMatchObject({ tasks: 1 });
    const mirror = path.join(cacheDir, "B");
    expect(existsSync(path.join(mirror, "proj-a/FINDINGS.md"))).toBe(true);
    expect(existsSync(path.join(mirror, "proj-a/review.md"))).toBe(true);
    expect(existsSync(path.join(mirror, "stores.yaml"))).toBe(true);
    expect(existsSync(path.join(mirror, "proj-a/README.md"))).toBe(false);
    expect(existsSync(path.join(cacheDir, "blobs", blobSha(Buffer.from("# Findings\n\n- alpha\n"))))).toBe(true);
  });

  it("ignores blob ids that are not canonical shas and content that does not match its id", async () => {
    const evil = "../../../../escaped-by-blob-id";
    const store = fakeStore({ "app/FINDINGS.md": "# app\n" }, { extraTree: [{ path: "app/notes/x.md", type: "blob", sha: evil, size: 3 }] });
    const { projects } = await service(store).projects(B);
    expect(projects.map((p) => p.name)).toContain("app");
    expect(store.calls.blob).toBe(1); // only the real blob was requested
    expect(existsSync(path.join(dir, "cache", evil))).toBe(false);
    expect(existsSync(path.resolve(dir, "cache", "blobs", evil))).toBe(false);
  });

  it("edits one schedule with the CLI's format, keeps list prompts intact, and refuses a stale edit", async () => {
    const sched = { id: "a1b2c3d4", name: "Nightly", enabled: true, computer: "Linuxbox", harness: "claude", every: "daily", at: "02:00",
      prompt: "Do this:\n- first\n- second", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
    const yamlText = dump({ version: 1, schedules: [sched, { ...sched, id: "e5f6a7b8", name: "Other" }] });
    const store = fakeStore({ "proj-a/FINDINGS.md": "# Findings\n", "proj-a/schedules.yaml": yamlText });
    const svc = service(store);
    const listed = { ...sched, project: "proj-a", nextRun: "2026-10-11T02:00:00.000Z", lastRun: null, lastRuns: [], running: false, owned: true };

    await svc.saveSchedule(B, { project: "proj-a", id: sched.id, original: listed, schedule: { ...listed, name: "Nightly audit" } });
    const post = store.posts.find((p) => p.path === "proj-a/schedules.yaml")!;
    expect(post.sha).toBe(blobSha(Buffer.from(yamlText)));
    const saved = load(Buffer.from(post.content, "base64").toString("utf8")) as { schedules: Array<Record<string, unknown>> };
    expect(saved.schedules.map((x) => x.name)).toEqual(["Nightly audit", "Other"]);
    expect(saved.schedules[0].prompt).toBe("Do this:\n- first\n- second");
    expect(saved.schedules[0]).not.toHaveProperty("nextRun");

    // The editor still holds the old copy: the file's entry changed, so the save is refused.
    await expect(svc.saveSchedule(B, { project: "proj-a", id: sched.id, original: listed, schedule: { ...listed, name: "Stale" } }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("fetches blobs in one batch when the Hook offers it", async () => {
    const hook = fakeStore({ "app/FINDINGS.md": "# app\n- a\n", "app/tasks.md": "# tasks\n", "app/notes/2026-10-10.md": "note\n" }, { batch: true });
    const { projects } = await service(hook).projects(B);
    expect(projects.map((p) => p.name)).toContain("app");
    expect(hook.calls.blobs).toBe(1);
    expect(hook.calls.blob).toBe(0);
  });

  it("reuses cached blobs and drops files no longer in the tree", async () => {
    const store = fakeStore({ "proj-a/FINDINGS.md": "A", "proj-a/review.md": "R" });
    const cacheDir = path.join(dir, "cache");
    const svc = service(store, cacheDir);
    await svc.projects(B);
    const blobsAfterFirst = store.calls.blob;
    expect(blobsAfterFirst).toBe(2);

    store.change({ "proj-a/FINDINGS.md": "A2", "proj-a/review.md": null, "proj-c/truths.md": "T" });
    const { projects } = await svc.projects(B);

    expect(projects.map((p) => p.name)).toEqual(["proj-a", "proj-c"]);
    // Only the new or changed blobs download; the deleted file's blob never does.
    expect(store.calls.blob - blobsAfterFirst).toBe(2);
    const mirror = path.join(cacheDir, "B");
    expect(existsSync(path.join(mirror, "proj-a/review.md"))).toBe(false);
    expect(existsSync(path.join(mirror, "proj-c/truths.md"))).toBe(true);
  });

  it("approves a queue item and uploads each changed file with its old sha", async () => {
    const initial = { "proj-a/FINDINGS.md": "# Findings\n", "proj-a/review.md": REVIEW_TEXT };
    const store = fakeStore(initial);
    const svc = service(store);
    await svc.findings(B, "proj-a");

    const result = await svc.reviewAction(B, { project: "proj-a", action: "approve", line: "- pending item" });

    expect(result.ok).toBe(true);
    const reviewPost = store.posts.find((p) => p.path === "proj-a/review.md");
    const findingsPost = store.posts.find((p) => p.path === "proj-a/FINDINGS.md");
    expect(reviewPost).toBeDefined();
    expect(findingsPost).toBeDefined();
    expect(reviewPost!.sha).toBe(blobSha(Buffer.from(REVIEW_TEXT)));
    expect(Buffer.from(reviewPost!.content, "base64").toString("utf8")).not.toContain("pending item");
    expect(Buffer.from(findingsPost!.content, "base64").toString("utf8")).toContain("pending item");
  });

  it("adds a finding with the CLI's writer and uploads FINDINGS.md with its old sha", async () => {
    const initial = { "proj-a/FINDINGS.md": "# Findings\n" };
    const store = fakeStore(initial);
    const svc = service(store);
    await svc.findings(B, "proj-a");

    const result = await svc.addFinding(B, { project: "proj-a", text: "The relay must never share the daemon origin" });

    expect(result.ok).toBe(true);
    const post = store.posts.find((p) => p.path === "proj-a/FINDINGS.md");
    expect(post?.sha).toBe(blobSha(Buffer.from("# Findings\n")));
    expect(Buffer.from(post!.content, "base64").toString("utf8")).toContain("The relay must never share the daemon origin");
    await expect(svc.addFinding(B, { project: "proj-a", text: "  " })).rejects.toThrow();
  });
});
