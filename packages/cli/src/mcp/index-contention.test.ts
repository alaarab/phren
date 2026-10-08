import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import { CLI_PATH, makeTempDir, writeFile } from "../test-helpers.js";

// Reproduces 2026-10-08: ~15 concurrent agents writing through MCP while hooks
// and other sessions keep re-taking the shared index rebuild lock. Every call
// used to fail with "Could not refresh the local index; retry shortly."
let tmp: ReturnType<typeof makeTempDir> | undefined;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  tmp?.cleanup();
  tmp = undefined;
});

const parse = (result: unknown) => JSON.parse(((result as { content: Array<{ text: string }> }).content)[0].text);

it("keeps concurrent MCP calls from several servers working while other processes rebuild", async () => {
  tmp = makeTempDir("mcp-index-contention-");
  const store = path.join(tmp.path, "store");
  writeFile(path.join(store, "phren.root.yaml"), "version: 1\ninstallMode: shared\nsyncMode: managed-git\n");
  writeFile(path.join(store, ".config", "modules.yaml"), "version: 1\nenabled:\n  tasks: true\n");
  writeFile(path.join(store, "demo", "summary.md"), "# Demo\nA demo project.\n");
  writeFile(path.join(store, "demo", "tasks.md"), "# Tasks\n\n## Queue\n\n- Seed task\n");
  execFileSync("git", ["init", "--quiet", store]);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  Object.assign(env, {
    PHREN_PATH: store, PHREN_PULL_INTERVAL_SECONDS: "0", PHREN_AUTOSAVE: "off",
    PHREN_EMBEDDING: "off", PHREN_FEATURE_NATIVE_MEMORY: "off", PHREN_INDEX_BUSY_WAIT_MS: "400",
  });
  for (let i = 0; i < 3; i++) {
    const client = new Client({ name: `contention-${i}`, version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [process.env.PHREN_TEST_CLI || CLI_PATH, store], env, stderr: "ignore" }));
    clients.push(client);
  }

  // Stand-in for hooks' detached reindexes and other sessions' servers: a live
  // process (this one) holds the rebuild lock most of the time.
  const lock = path.join(store, ".runtime", "index-rebuild.lock");
  let contending = true;
  const holder = (async () => {
    while (contending) {
      writeFile(lock, `${process.pid}\n${Date.now()}`);
      await new Promise(resolve => setTimeout(resolve, 250));
      try { fs.unlinkSync(lock); } catch { /* already gone */ }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  })();

  try {
    const calls = clients.flatMap((client, c) => [
      ...Array.from({ length: 5 }, (_, i) => client.callTool({ name: "add_task", arguments: { project: "demo", item: [`Contention task ${c}-${i}`] } })),
      ...Array.from({ length: 2 }, (_, i) => client.callTool({ name: "add_finding", arguments: { project: "demo", finding: [`Contention finding zebracorn ${c}-${i} about index lock waits`] } })),
      ...Array.from({ length: 3 }, () => client.callTool({ name: "search_knowledge", arguments: { query: "demo" } })),
      ...Array.from({ length: 2 }, () => client.callTool({ name: "get_tasks", arguments: { project: "demo" } })),
    ]);
    const results = (await Promise.all(calls)).map(parse);
    const failures = results.filter(result => result.ok !== true);
    expect(failures).toEqual([]);
  } finally {
    contending = false;
    await holder;
    try { fs.unlinkSync(lock); } catch { /* already gone */ }
  }

  const tasks = fs.readFileSync(path.join(store, "demo", "tasks.md"), "utf8");
  for (let c = 0; c < 3; c++) for (let i = 0; i < 5; i++) expect(tasks).toContain(`Contention task ${c}-${i}`);
  // Once the lock is free the next index read refreshes past the last good index.
  await new Promise(resolve => setTimeout(resolve, 1100));
  const found = parse(await clients[0].callTool({ name: "search_knowledge", arguments: { query: "zebracorn" } }));
  expect(found.ok).toBe(true);
  expect(JSON.stringify(found)).toContain("zebracorn");
}, 60_000);
