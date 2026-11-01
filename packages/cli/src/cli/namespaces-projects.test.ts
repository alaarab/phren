import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initTestPhrenRoot } from "../test-helpers.js";
import { readProjectConfig } from "../project-config.js";
import { handleProjectsNamespace } from "./namespaces-projects.js";

let root = "";
let store = "";
const originalPhrenPath = process.env.PHREN_PATH;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "phren-projects-cli-"));
  store = path.join(root, ".phren");
  mkdirSync(store, { recursive: true });
  initTestPhrenRoot(store);
  process.env.PHREN_PATH = store;
});

afterAll(() => {
  if (originalPhrenPath === undefined) delete process.env.PHREN_PATH;
  else process.env.PHREN_PATH = originalPhrenPath;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(process, "exit").mockImplementation((code?: number) => {
    throw new ExitSignal(code ?? 0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

function writeProject(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(store, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(dir, file);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return dir;
}

async function run(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a) => { stdout.push(a.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...a) => { stderr.push(a.join(" ")); });
  const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write);
  let exitCode = 0;
  try {
    await handleProjectsNamespace(args, "");
  } catch (caught) {
    if (caught instanceof ExitSignal) exitCode = caught.code;
    else throw caught;
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode };
}

async function runWithStdin(args: string[], input: string) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const stdin = new PassThrough();
  stdin.end(input);
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  try {
    return await run(args);
  } finally {
    if (descriptor) Object.defineProperty(process, "stdin", descriptor);
    else delete (process as { stdin?: unknown }).stdin;
  }
}

describe("phren projects namespace", () => {
  it("lists projects sorted, tags findings and tasks, and skips global and archived dirs", async () => {
    writeProject("zebra", { "FINDINGS.md": "# Zebra\n" });
    writeProject("alpha", { "tasks.md": "# Alpha\n" });
    writeProject("global");
    writeProject("old.archived", { "summary.md": "# Old\n" });

    const { stdout, exitCode } = await run(["list"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Projects in ${store}:`);
    expect(stdout).toContain("  alpha  [tasks]");
    expect(stdout).toContain("  zebra  [findings]");
    expect(stdout.indexOf("  alpha")).toBeLessThan(stdout.indexOf("  zebra"));
    expect(stdout).not.toContain("  global");
    expect(stdout).not.toContain("  old");
    expect(stdout).toContain("2 project(s) total.");
  });

  it("records ownership and hook settings in phren.project.yaml", async () => {
    writeProject("gamma");

    const { stdout, exitCode } = await run(["configure", "gamma", "--ownership=managed", "--hooks=off"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Updated gamma: ownership=phren-managed, hooks=off");
    const config = readProjectConfig(store, "gamma");
    expect(config.ownership).toBe("phren-managed");
    expect(config.hooks?.enabled).toBe(false);
  });

  it("rejects invalid ownership and hook values without writing config", async () => {
    writeProject("delta");

    const ownership = await run(["configure", "delta", "--ownership=sometimes"]);
    expect(ownership.exitCode).toBe(1);
    expect(ownership.stderr).toContain("Usage: phren projects configure <name> [--ownership=phren-managed|detached|repo-managed] [--hooks=on|off]");

    const hooks = await run(["configure", "delta", "--hooks=maybe"]);
    expect(hooks.exitCode).toBe(1);
    expect(hooks.stderr).toContain('Invalid --hooks value "maybe". Use on or off.');

    expect(existsSync(path.join(store, "delta", "phren.project.yaml"))).toBe(false);
  });

  it("refuses to configure a project that does not exist", async () => {
    const { stderr, exitCode } = await run(["configure", "ghost", "--hooks=on"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Project "ghost" not found.');
    expect(existsSync(path.join(store, "ghost"))).toBe(false);
  });

  it("archives a project without losing data and unarchives it again", async () => {
    writeProject("keeper", {
      "FINDINGS.md": "# Keeper\n\n## 2026-01-01\n\n- Keep me\n",
      "summary.md": "# Summary\n",
    });

    const archived = await run(["archive", "keeper"]);
    expect(archived.exitCode).toBe(0);
    expect(archived.stdout).toContain('Archived project "keeper".');
    expect(existsSync(path.join(store, "keeper"))).toBe(false);
    expect(readFileSync(path.join(store, "keeper.archived", "FINDINGS.md"), "utf8")).toContain("Keep me");

    const restored = await run(["unarchive", "keeper"]);
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout).toContain('Unarchived project "keeper".');
    expect(existsSync(path.join(store, "keeper.archived"))).toBe(false);
    expect(readFileSync(path.join(store, "keeper", "summary.md"), "utf8")).toBe("# Summary\n");
  });

  it("refuses to archive over an existing archive and leaves both copies alone", async () => {
    writeProject("clash", { "summary.md": "active\n" });
    writeProject("clash.archived", { "summary.md": "archived\n" });

    const { stderr, exitCode } = await run(["archive", "clash"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Archive "clash.archived" already exists.');
    expect(readFileSync(path.join(store, "clash", "summary.md"), "utf8")).toBe("active\n");
    expect(readFileSync(path.join(store, "clash.archived", "summary.md"), "utf8")).toBe("archived\n");
  });

  it("names the available archives when the requested one is missing", async () => {
    writeProject("kept.archived", { "summary.md": "kept\n" });

    const { stderr, exitCode } = await run(["unarchive", "missing"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('No archive found for "missing".');
    expect(stderr).toMatch(/Available archives:.*kept/);
    expect(existsSync(path.join(store, "kept.archived"))).toBe(true);
    expect(existsSync(path.join(store, "missing"))).toBe(false);
  });

  it("exports summary, findings, tasks and instructions as JSON", async () => {
    writeProject("exporter", {
      "summary.md": "# Exporter\n",
      "FINDINGS.md": "# Exporter Findings\n\n## 2026-01-01\n\n- A durable fact\n",
      "tasks.md": "# Exporter tasks\n\n## Active\n\n- [ ] Ship it\n",
      "AGENTS.md": "# Instructions\n",
    });

    const { stdout, exitCode } = await run(["export", "exporter"]);

    expect(exitCode).toBe(0);
    const exported = JSON.parse(stdout.slice(stdout.indexOf("{"))) as Record<string, any>;
    expect(exported).toMatchObject({
      project: "exporter",
      version: 1,
      summary: "# Exporter\n",
      agentsMd: "# Instructions\n",
      claudeMd: "# Instructions\n",
      findingsRaw: expect.stringContaining("A durable fact"),
      taskRaw: expect.stringContaining("Ship it"),
    });
    expect(exported.learnings).toContainEqual(expect.objectContaining({ text: "A durable fact" }));
    expect(exported.task.Active).toContainEqual(expect.objectContaining({ line: "Ship it", section: "Active" }));
  });

  it("imports exported files into a new project and refuses to overwrite it", async () => {
    const payload = {
      project: "Imported-Project",
      summary: "# S\n",
      agentsMd: "# A\n",
      findingsRaw: "# F\n",
      taskRaw: "# T\n",
    };
    const importFile = path.join(root, "import.json");
    writeFileSync(importFile, JSON.stringify(payload));

    const { stdout, exitCode } = await run(["import", importFile]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Imported project "imported-project": summary.md, AGENTS.md, FINDINGS.md, tasks.md');
    const projectDir = path.join(store, "imported-project");
    expect(readFileSync(path.join(projectDir, "summary.md"), "utf8")).toBe("# S\n");
    expect(readFileSync(path.join(projectDir, "AGENTS.md"), "utf8")).toBe("# A\n");
    expect(readFileSync(path.join(projectDir, "FINDINGS.md"), "utf8")).toBe("# F\n");
    expect(readFileSync(path.join(projectDir, "tasks.md"), "utf8")).toBe("# T\n");

    const again = await run(["import", importFile]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain('Project "imported-project" already exists.');
  });

  it("removes a project only when its name is typed back", async () => {
    writeProject("doomed", { "summary.md": "# Doomed\n", "nested/deep.md": "deep\n" });

    const aborted = await runWithStdin(["remove", "doomed"], "not-the-name\n");
    expect(aborted.exitCode).toBe(0);
    expect(aborted.stdout).toContain("Aborted.");
    expect(existsSync(path.join(store, "doomed", "nested", "deep.md"))).toBe(true);

    const removed = await runWithStdin(["remove", "doomed"], "doomed\n");
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain('Removed project "doomed".');
    expect(existsSync(path.join(store, "doomed"))).toBe(false);
  });
});
