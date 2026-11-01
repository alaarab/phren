import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createRouteHandler } from "./server-routes.js";

let root: string | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("keeps promptEntryId on finished conversation history entries", async () => {
  const fixture = JSON.parse(await readFile(fileURLToPath(new URL("../../fixtures/conformance/checkpoint-prompt-identity.json", import.meta.url)), "utf8")) as {
    source: string; session: string; rows: Record<string, unknown>[]; entries: { line: number; promptEntryId?: string | null }[];
  };
  root = await mkdtemp(path.join(tmpdir(), "phren-history-prompt-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", root);
  vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge"));
  const project = path.join(root, "projects", "test");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, `${fixture.session}.jsonl`), fixture.rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const handler = createRouteHandler({ modules: { has: () => true }, streams: {} } as never);
  server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const query = new URLSearchParams({ historical: "1", source: fixture.source, session: fixture.session, beforeLine: String(fixture.rows.length) });
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/transcripts/history?${query}`);
  expect(response.status).toBe(200);
  const page = await response.json() as { entries: { line: number; promptEntryId?: string }[] };
  expect(page.entries.map(entry => ({ line: entry.line, promptEntryId: entry.promptEntryId ?? null })))
    .toEqual(fixture.entries.map(entry => ({ line: entry.line, promptEntryId: entry.promptEntryId ?? null })));
});

it("reads a finished conversation through history without a live target and gates identity reads", async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-history-route-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", root);
  vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge"));
  const session = "11111111-1111-4111-8111-111111111111";
  const project = path.join(root, "projects", "test");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, `${session}.jsonl`), [
    { type: "user", message: { role: "user", content: "find this old message" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const handler = createRouteHandler({ modules: { has: () => true }, streams: {} } as never);
  server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/v1/transcripts/history`;
  const query = new URLSearchParams({ historical: "1", source: "claude", session, beforeLine: "2" });
  const response = await fetch(`${base}?${query}`);
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page).toMatchObject({ type: "older", source: "claude", session, startLine: 0, hasMore: false });
  expect(page.entries.map((row: { line: number }) => row.line)).toEqual([0, 1]);
  expect(page.entries[0].raw.message.content).toBe("find this old message");
  for (const [patch, headers, status] of [
    [{ beforeLine: "0" }, {}, 400],
    [{ session: "../escape" }, {}, 400],
    [{ pane: "p1" }, {}, 400],
    [{}, { "x-phren-origin": "agent" }, 403],
    [{}, { "x-phren-origin": "peer" }, 403],
  ] as const) {
    const requestQuery = new URLSearchParams({ ...Object.fromEntries(query), ...patch });
    expect((await fetch(`${base}?${requestQuery}`, { headers })).status).toBe(status);
  }
});
