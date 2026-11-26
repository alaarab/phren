import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";

/** The prompt hook end to end for a project over its open-task budget: it still
 * injects memory, files no task, and says so in its trace line and the recall trace. */
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

describe.skipIf(!fs.existsSync(cli))("hook-prompt open-task budget", () => {
  let tmp: { path: string; cleanup: () => void };
  let store: string, workRepo: string;
  const tasks = "# myproject tasks\n\n## Active\n\n## Queue\n\n- [ ] First queued item\n- [ ] Second queued item\n- [ ] Third queued item\n\n## Done\n";

  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(store, file)), { recursive: true });
    fs.writeFileSync(path.join(store, file), text);
  };
  const run = (prompt: string, session: string) => spawnSync(process.execPath, [cli, "hook-prompt"], {
    input: JSON.stringify({ prompt, cwd: workRepo, session_id: session }),
    env: { ...process.env, PHREN_PATH: store, PHREN_PROFILE: "personal", HOME: tmp.path, PHREN_FEATURE_AUTO_EXTRACT: "0" },
    encoding: "utf8", timeout: 60_000,
  }).stdout ?? "";
  const lastTrace = () => {
    const lines = fs.readFileSync(path.join(store, ".runtime", "recall-trace.jsonl"), "utf8").split("\n").filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  };

  beforeAll(() => {
    tmp = makeTempDir("hook-prompt-budget-");
    store = path.join(tmp.path, ".phren");
    workRepo = path.join(tmp.path, "Projects", "MyProject");
    fs.mkdirSync(path.join(workRepo, ".git"), { recursive: true });
    fs.mkdirSync(store, { recursive: true });
    initTestPhrenRoot(store);
    write("profiles/personal.yaml", "name: personal\nprojects:\n  - global\n  - myproject\n");
    write("global/FINDINGS.md", "# global Findings\n\n- Keep notes short.\n");
    write("myproject/FINDINGS.md", "# myproject Findings\n\n- The render callback reads the frame size the main thread pushed before it.\n");
    write("myproject/tasks.md", tasks);
    write(".config/workflow-policy.json", JSON.stringify({ schemaVersion: 1, taskMode: "auto" }));
    write(".config/retention-policy.json", JSON.stringify({ schemaVersion: 1, budgets: { openTasks: 2 } }));
  });
  afterAll(() => tmp?.cleanup());

  it("injects memory but files no task, and notes the pause in the trace line and the recall trace", () => {
    const output = run("Fix the render callback so it reads the frame size from the main thread", "budget-session");
    expect(output).toContain("myproject/FINDINGS.md");
    expect(output).toMatch(/trace: .*; tasks=paused open 3\/2/);
    expect(output).not.toContain("Queued task");
    expect(fs.readFileSync(path.join(store, "myproject", "tasks.md"), "utf8")).toBe(tasks);
    expect(lastTrace().taskCapturePaused).toEqual({ open: 3, budget: 2 });
  });
});
