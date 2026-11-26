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

describe.skipIf(!fs.existsSync(cli))("hook-prompt open-task budget for a team-store project", () => {
  let tmp: { path: string; cleanup: () => void };
  let primary: string, team: string, workRepo: string;
  const tasks = "# teamproj tasks\n\n## Active\n\n## Queue\n\n- [ ] First queued item\n- [ ] Second queued item\n- [ ] Third queued item\n\n## Done\n";
  const write = (root: string, file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };

  beforeAll(() => {
    tmp = makeTempDir("hook-prompt-team-budget-");
    primary = path.join(tmp.path, ".phren");
    team = path.join(tmp.path, "team-store");
    workRepo = path.join(tmp.path, "Projects", "teamproj");
    fs.mkdirSync(path.join(workRepo, ".git"), { recursive: true });
    for (const root of [primary, team]) { fs.mkdirSync(root, { recursive: true }); initTestPhrenRoot(root); }
    write(primary, "stores.yaml", JSON.stringify({ version: 1, stores: [{ id: "aaaaaaaa", name: "personal", path: primary, role: "primary", sync: "managed-git" }] }));
    write(primary, ".runtime/attached-stores.yaml", JSON.stringify({ version: 1, stores: [{ id: "bbbbbbbb", name: "team", path: team, role: "team", sync: "managed-git", projects: ["teamproj"] }] }));
    write(primary, "global/FINDINGS.md", "# global Findings\n\n- Keep notes short.\n");
    write(primary, ".config/workflow-policy.json", JSON.stringify({ schemaVersion: 1, taskMode: "auto" }));
    // The primary store keeps the 150 default; the team store, which owns the project, sets 2.
    write(team, ".config/retention-policy.json", JSON.stringify({ schemaVersion: 1, budgets: { openTasks: 2 } }));
    write(team, "teamproj/FINDINGS.md", "# teamproj Findings\n\n- The render callback reads the frame size the main thread pushed before it.\n");
    write(team, "teamproj/tasks.md", tasks);
  });
  afterAll(() => tmp?.cleanup());

  it("uses the budget of the store that owns the project", () => {
    const output = spawnSync(process.execPath, [cli, "hook-prompt"], {
      input: JSON.stringify({ prompt: "Fix the render callback so it reads the frame size from the main thread", cwd: workRepo, session_id: "team-budget" }),
      env: { ...process.env, PHREN_PATH: primary, PHREN_PROFILE: "", HOME: tmp.path, PHREN_FEATURE_AUTO_EXTRACT: "0" },
      encoding: "utf8", timeout: 60_000,
    }).stdout ?? "";
    expect(output).toContain("teamproj/FINDINGS.md");
    expect(output).toMatch(/trace: .*; tasks=paused open 3\/2/);
    expect(fs.readFileSync(path.join(team, "teamproj", "tasks.md"), "utf8")).toBe(tasks);
  });
});

