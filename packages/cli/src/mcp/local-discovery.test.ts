import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import { CLI_PATH, makeTempDir, writeFile } from "../test-helpers.js";
import { writeStoreRegistry } from "../store-registry.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 1100));
let tmp: ReturnType<typeof makeTempDir> | undefined;
let client: Client | undefined;
afterEach(async () => { await client?.close(); client = undefined; tmp?.cleanup(); tmp = undefined; });

it("refreshes a single live MCP after uncommitted profile and document changes with pulls disabled", async () => {
  tmp = makeTempDir("mcp-local-discovery-");
  const store = path.join(tmp.path, "store");
  const profile = path.join(store, "profiles", "test.yaml");
  const summary = path.join(store, "nas-media", "summary.md");
  writeFile(path.join(store, "phren.root.yaml"), "version: 1\ninstallMode: shared\nsyncMode: managed-git\n");
  writeFile(path.join(store, ".config", "modules.yaml"), "version: 1\nenabled:\n  tasks: true\n");
  writeFile(profile, "name: test\nprojects: [nas-media]\n");
  writeFile(path.join(store, "nas-media", "tasks.md"), "# Tasks\n\n## Queue\n\n- Connect the media library\n");
  execFileSync("git", ["init", "--quiet", store]);
  execFileSync("git", ["-C", store, "remote", "add", "origin", path.join(tmp.path, "absent-remote")]);
  const trace = path.join(tmp.path, "git-trace.log");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  Object.assign(env, {
    PHREN_PATH: store, PHREN_PROFILE: "test", PHREN_PULL_INTERVAL_SECONDS: "0", PHREN_AUTOSAVE: "off",
    PHREN_EMBEDDING: "off", PHREN_FEATURE_NATIVE_MEMORY: "off", GIT_TRACE: trace.replaceAll("\\", "/"),
  });
  client = new Client({ name: "local-discovery-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [process.env.PHREN_TEST_CLI || CLI_PATH, store], env, stderr: "ignore" }));
  const call = async (name: string) => {
    const result = await client!.callTool({ name: "get_project_summary", arguments: { name } });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  };
  const initial = await call("nas-media");
  expect(initial.ok).toBe(true);
  expect(initial.data.summary).toBeNull();
  expect(initial.data.files.map((f: { filename: string }) => f.filename)).toEqual(["tasks.md"]);

  // No index event/reload for unchanged reads, even across a freshness interval.
  const events = () => fs.readFileSync(path.join(store, ".runtime", "index-events.jsonl"), "utf8");
  const unchanged = events();
  await tick();
  await Promise.all(Array.from({ length: 8 }, () => call("nas-media")));
  expect(events()).toBe(unchanged);

  // These are external, uncommitted writes: no MCP write and no HEAD change.
  writeFile(summary, "# NAS media\nCurrent local summary.\n");
  writeFile(path.join(store, "new-project", "summary.md"), "# New project\nUncommitted project.\n");
  writeFile(profile, "name: test\nprojects: [nas-media, new-project]\n");
  await tick();
  const [updated, added] = await Promise.all([call("nas-media"), call("new-project")]);
  expect(updated.data.summary).toContain("Current local summary.");
  expect(added.data.summary).toContain("Uncommitted project.");

  const team = path.join(tmp.path, "team");
  writeFile(path.join(team, "team-project", "summary.md"), "# Team project\nAttached locally.\n");
  writeStoreRegistry(store, { version: 1, stores: [
    { id: "aaa11111", name: "personal", path: store, role: "primary", sync: "managed-git" },
    { id: "bbb22222", name: "team", path: team, role: "team", sync: "managed-git" },
  ] });
  writeFile(profile, "name: test\nprojects: [nas-media, new-project, team-project]\n");
  await tick();
  expect((await call("team-project")).data.summary).toContain("Attached locally.");
  fs.unlinkSync(path.join(store, ".runtime", "attached-stores.yaml"));
  await tick();
  expect((await call("team-project")).ok).toBe(false);

  // Atomic replacement can preserve mtime and size; it must still refresh.
  const stat = fs.statSync(summary);
  writeFile(summary + ".new", "# NAS media\nUpdated local summary.\n");
  fs.utimesSync(summary + ".new", stat.atime, stat.mtime);
  fs.renameSync(summary + ".new", summary);
  await tick();
  expect((await call("nas-media")).data.summary).toContain("Updated local summary.");

  fs.unlinkSync(summary);
  writeFile(profile, "name: test\nprojects: [nas-media]\n");
  const lock = path.join(store, ".runtime", "index-rebuild.lock");
  writeFile(lock, `${process.pid}\n`);
  await tick();
  expect((await call("nas-media"))).toMatchObject({ ok: false, error: expect.stringContaining("retry") });
  fs.unlinkSync(lock);
  await tick();
  expect((await call("nas-media")).data.summary).toBeNull();
  expect((await call("new-project")).ok).toBe(false);
  const gitTrace = fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "";
  expect(gitTrace).not.toMatch(/\b(fetch|pull|ls-remote)\b/);
}, 60_000);
