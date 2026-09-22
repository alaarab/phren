import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type Handler = (input: unknown, output: unknown) => Promise<void>;
type PluginHandlers = Record<string, Handler>;

async function loadPlugin(): Promise<PluginHandlers> {
  const url = new URL("../../plugins/opencode/phren-transcript.js", import.meta.url);
  const module = await import(url.href) as { PhrenTranscriptPlugin: () => Promise<PluginHandlers> };
  return module.PhrenTranscriptPlugin();
}

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

describe("opencode fan-out permissions", () => {
  const saved = { job: process.env.PHREN_FANOUT_JOB, dir: process.env.PHREN_FANOUT_DIR,
    store: process.env.PHREN_PATH, cwd: process.cwd() };
  const roots: string[] = [];
  afterEach(async () => {
    restore("PHREN_FANOUT_JOB", saved.job);
    restore("PHREN_FANOUT_DIR", saved.dir);
    restore("PHREN_PATH", saved.store);
    process.chdir(saved.cwd);
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it("writes blocked.json when a fan-out worker's permission is denied", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "phren-fanout-")); roots.push(directory);
    process.env.PHREN_FANOUT_JOB = "job-deny";
    process.env.PHREN_FANOUT_DIR = directory;
    const handlers = await loadPlugin();
    const output: { status?: string } = {};
    await handlers["permission.ask"]({ type: "read", pattern: "~/.ssh/id_rsa" }, output);
    expect(output.status).toBe("deny");
    const blocked = JSON.parse(await readFile(path.join(directory, "blocked.json"), "utf8"));
    expect(blocked).toMatchObject({ type: "read", pattern: "~/.ssh/id_rsa" });
    expect(blocked.message).toContain("read");
    expect(typeof blocked.at).toBe("string");
  });

  it("allows edit, bash and webfetch without a block", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "phren-fanout-")); roots.push(directory);
    process.env.PHREN_FANOUT_JOB = "job-allow";
    process.env.PHREN_FANOUT_DIR = directory;
    const handlers = await loadPlugin();
    for (const type of ["edit", "bash", "webfetch", "doom_loop"]) {
      const output: { status?: string } = {};
      await handlers["permission.ask"]({ type }, output);
      expect(output.status).toBe("allow");
    }
    await expect(readFile(path.join(directory, "blocked.json"), "utf8")).rejects.toThrow();
  });

  it("allows external_directory under the scratch root and this machine's own trees", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "phren-scratch-")); roots.push(scratch);
    const job = path.join(scratch, "job"), worktree = path.join(job, "worktree");
    await mkdir(worktree, { recursive: true });
    process.chdir(worktree);
    process.env.PHREN_FANOUT_JOB = "job-scratch";
    process.env.PHREN_FANOUT_DIR = job;
    const handlers = await loadPlugin();
    const inside: { status?: string } = {};
    // cwd may resolve a symlinked tmp root; build the pattern from it.
    const scratchRoot = path.dirname(path.dirname(process.cwd()));
    await handlers["permission.ask"]({ type: "external_directory", pattern: path.join(scratchRoot, "shared") }, inside);
    expect(inside.status).toBe("allow");
    // A worktree links its node_modules into the main checkout and a build
    // shells out to the toolchain, so the machine's own trees are readable.
    const machine: { status?: string } = {};
    await handlers["permission.ask"](
      { type: "external_directory", pattern: path.join(process.env.HOME ?? "", "Projects/app/node_modules") }, machine);
    expect(machine.status).toBe("allow");
    const outside: { status?: string } = {};
    await handlers["permission.ask"]({ type: "external_directory", pattern: "/etc/ssh" }, outside);
    expect(outside.status).toBe("deny");
    const blocked = JSON.parse(await readFile(path.join(job, "blocked.json"), "utf8"));
    expect(blocked).toMatchObject({ type: "external_directory", pattern: "/etc/ssh" });
  });

  it("falls back to the store's agent-fanouts directory", async () => {
    const store = await mkdtemp(path.join(tmpdir(), "phren-store-")); roots.push(store);
    process.env.PHREN_FANOUT_JOB = "job-store";
    delete process.env.PHREN_FANOUT_DIR;
    process.env.PHREN_PATH = store;
    const handlers = await loadPlugin();
    const output: { status?: string } = {};
    await handlers["permission.ask"]({ type: "task" }, output);
    expect(output.status).toBe("deny");
    const blocked = JSON.parse(await readFile(path.join(store, ".runtime", "agent-fanouts", "job-store", "blocked.json"), "utf8"));
    expect(blocked.type).toBe("task");
  });
});
