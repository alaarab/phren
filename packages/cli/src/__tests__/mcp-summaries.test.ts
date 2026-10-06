import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { register } from "../tools/summaries.js";
import type { McpContext } from "../tools/types.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
function mockServer() {
  const tools = new Map<string, Handler>();
  return {
    registerTool(name: string, _meta: unknown, handler: Handler) { tools.set(name, handler); },
    async call(name: string, args: Record<string, unknown>) { return JSON.parse((await tools.get(name)!(args)).content[0].text); },
  };
}

describe("agent-written topic summaries", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof mockServer>;
  beforeEach(() => {
    tmp = makeTempDir("mcp-sum-");
    grantAdmin(tmp.path);
    const proj = path.join(tmp.path, "demo");
    writeFile(path.join(proj, "summary.md"), "# demo\n");
    writeFile(path.join(proj, "FINDINGS.md"), "# demo\n\n## 2026-09-01\n\n- [pattern] live one\n");
    writeFile(path.join(proj, "reference", "topics", "api.md"), "# demo · api\n\n## Archived 2026-03-01\n\n- [pattern] RetryPolicy wraps outbound calls in `retry.ts`\n- [pitfall] Pool of 20 connections stalls under load; 12 is the ceiling\n");
    writeFile(path.join(proj, "reference", "topics", "cli-commands.md"), "# CLI commands\n\nphren search <q>\n");
    server = mockServer();
    const ctx: McpContext = {
      phrenPath: tmp.path, profile: "test",
      db: () => { throw new Error("no db needed"); },
      rebuildIndex: async () => {}, updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });
  afterEach(() => tmp.cleanup());

  it("lists topic archives and hands over a topic's newest bullets", async () => {
    const list = await server.call("get_topic_summaries", { project: "demo" });
    expect(list.ok).toBe(true);
    const api = list.data.topics.find((t: { topic: string }) => t.topic === "api");
    expect(api).toMatchObject({ bullets: 2, archive: true, structural: true });
    const doc = list.data.topics.find((t: { topic: string }) => t.topic === "cli-commands");
    expect(doc).toMatchObject({ bullets: 0, archive: false });
    const detail = await server.call("get_topic_summaries", { project: "demo", topic: "api", bullets: 10 });
    expect(detail.data.bullets.map((b: { text: string }) => b.text)).toEqual([
      "Pool of 20 connections stalls under load; 12 is the ceiling",
      "RetryPolicy wraps outbound calls in `retry.ts`",
    ]);
  });

  it("refuses a paragraph that names what the bullets do not, and stores one that does not", async () => {
    const bad = await server.call("set_topic_summary", { project: "demo", topic: "api", text: "Outbound calls go through RetryPolicy, which is built on the `tenacity` library and configured in FastAPI middleware, with a pool ceiling of 12." });
    expect(bad.ok).toBe(false);
    expect(bad.data.invented).toEqual(["tenacity", "FastAPI"]);

    const good = await server.call("set_topic_summary", { project: "demo", topic: "api", text: "Outbound calls go through RetryPolicy, implemented in `retry.ts`. The connection pool stalls under load at 20 connections, so 12 is the working ceiling. Nothing here has been superseded." });
    expect(good.ok).toBe(true);
    const topic = fs.readFileSync(path.join(tmp.path, "demo", "reference", "topics", "api.md"), "utf8");
    expect(topic).toContain("## Now");
    expect(topic).toContain("12 is the working ceiling");
    expect(topic).toContain("- [pattern] RetryPolicy"); // bullets untouched
    const summary = fs.readFileSync(path.join(tmp.path, "demo", "summary.md"), "utf8");
    expect(summary).toContain("## What phren knows");
    expect(summary).toContain("**api** — Outbound calls go through RetryPolicy, implemented in `retry.ts`.");
    const again = await server.call("get_topic_summaries", { project: "demo" });
    expect(again.data.topics.find((t: { topic: string }) => t.topic === "api").structural).toBe(false);
  });

  it("will not stamp a hand-written document", async () => {
    const res = await server.call("set_topic_summary", { project: "demo", topic: "cli-commands", text: "This document lists the phren search command and its arguments for people who use the CLI directly." });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/hand-written/);
  });
});
