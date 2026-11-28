import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

describe("hook-prompt abstain tail", () => {
  let tmp: ReturnType<typeof makeTempDir>;
  let store: string, workRepo: string, clock: string;
  const tasks = "# myproject tasks\n\n## Active\n\n## Queue\n\n## Done\n";
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(store, file)), { recursive: true });
    fs.writeFileSync(path.join(store, file), text);
  };
  const run = (prompt: string, session = "abstain-session") => {
    // --import takes a URL: Windows reads a bare C:\ path as a "c:" scheme and the CLI exits 1.
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(clock).href, cli, "hook-prompt"], {
      input: JSON.stringify({ prompt, cwd: workRepo, session_id: session }),
      env: { ...process.env, PHREN_PATH: store, PHREN_PROFILE: "personal", HOME: tmp.path,
        USERPROFILE: tmp.path, PHREN_FEATURE_AUTO_EXTRACT: "0", PHREN_CLANKER: "off",
        PHREN_BRIDGE_HOME: tmp.path, PHREN_BROWSER_SOCKET: "", PHREN_BROWSER_WATCH: "1", PHREN_PROACTIVITY: "high" },
      encoding: "utf8", timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    return result.stdout;
  };
  const lastTrace = () => {
    const lines = fs.readFileSync(path.join(store, ".runtime", "recall-trace.jsonl"), "utf8").trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  };
  const installPrePromptHook = () => {
    write("pre-prompt.cjs", `const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
console.log("custom context for " + input.session_id);
`);
    write(".runtime/install-preferences.json", JSON.stringify({ customHooks: [
      { event: "pre-prompt", command: `"${process.execPath}" "${path.join(store, "pre-prompt.cjs")}"` },
    ] }));
  };

  beforeEach(() => {
    tmp = makeTempDir("hook-prompt-abstain-");
    store = path.join(tmp.path, ".phren");
    workRepo = path.join(tmp.path, "Projects", "MyProject");
    clock = path.join(tmp.path, "clock.mjs");
    fs.mkdirSync(path.join(workRepo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, "browser.sock"), "");
    // Fixed stage timings let the snapshot compare the baseline hook output byte for byte.
    fs.writeFileSync(clock, "Date.now = () => Date.UTC(2026, 10, 26);\n");
    initTestPhrenRoot(store);
    write("profiles/personal.yaml", "name: personal\nprojects:\n  - myproject\n");
    write("myproject/FINDINGS.md", "# myproject Findings\n\n"
      + "- The render callback reads the frame size the main thread pushed before it.\n"
      + Array.from({ length: 24 }, (_, i) => `- Ceramics kiln temperature setting ${i}.\n`).join(""));
    write("myproject/tasks.md", tasks);
    write(".config/workflow-policy.json", JSON.stringify({ schemaVersion: 1, taskMode: "auto" }));
  });
  afterEach(() => tmp.cleanup());
  // The custom hook runs through cmd /c on Windows, whose quoting this test's command doesn't model; the tail logic is OS-independent.
  const withCustomHook = it.skipIf(process.platform === "win32");

  it("does not capture a requested task and prints nothing when recall abstains", () => {
    const output = run("Add a task to implement glimmerwick throttlebottom");
    expect(fs.readFileSync(path.join(store, "myproject", "tasks.md"), "utf8")).toBe(tasks);
    expect(output).toBe("");
    expect(lastTrace()).toMatchObject({ abstained: expect.any(String), injected: [] });
    expect(lastTrace().taskCapturePaused).toBeUndefined();
  }, 30_000);

  withCustomHook("prints custom pre-prompt output when recall abstains", () => {
    installPrePromptHook();
    expect(run("glimmerwick throttlebottom")).toBe("custom context for abstain-session\n");
    expect(lastTrace()).toMatchObject({ abstained: expect.any(String), injected: [] });
  }, 30_000);

  it.each([["glimmerwick throttlebottom", ""], ["browser glimmerwick throttlebottom", "phren browser env"]])("prints only the once-per-session browser hint when recall abstains for %s", (prompt, hint) => {
    const out = run(prompt);
    if (hint) expect(out).toContain(hint); else expect(out).toBe("");
    expect(lastTrace()).toMatchObject({ abstained: expect.any(String), injected: [] });
    const markers = fs.readdirSync(path.join(store, ".sessions"));
    expect(markers.some(name => name.startsWith("noticed-"))).toBe(false);
  }, 30_000);

  it("records no task capture budget pause now that tasks are retired", () => {
    const queued = tasks.replace("## Queue\n", "## Queue\n\n- [ ] First queued item\n- [ ] Second queued item\n");
    write("myproject/tasks.md", queued);
    write(".config/retention-policy.json", JSON.stringify({ schemaVersion: 1, budgets: { openTasks: 1 } }));
    expect(run("Implement glimmerwick throttlebottom cache handling")).toBe("");
    expect(fs.readFileSync(path.join(store, "myproject", "tasks.md"), "utf8")).toBe(queued);
    expect(lastTrace()).toMatchObject({ abstained: expect.any(String), injected: [] });
    expect(lastTrace().taskCapturePaused).toBeUndefined();
  }, 30_000);

  withCustomHook("preserves every output byte for an injecting prompt", () => {
    installPrePromptHook();
    expect(run("Fix the render callback so it reads the frame size from the main thread", "inject-session")).toMatchInlineSnapshot(`
      "custom context for inject-session
      ◆ phren · myproject · 1 result
      <phren-context>
      [myproject/FINDINGS.md] (findings) fb:myproject/FINDINGS.md:4fafcc9ac398
      - The render callback reads the frame size the main thread pushed before it.

      </phren-context>
      ◆ phren · trace: intent=debug; matched=render,callback,read,frame,size,main,thread; budget=84/2000;tokens≈84/550; stages=index:0ms,search:0ms,trust:0ms,rank:0ms,select:0ms

      [phren finding-sensitivity=balanced] Save non-obvious patterns, decisions, pitfalls, and bugs worth remembering next session.
      ◈ phren · consolidation ready
      <phren-notice>
      Findings ready for consolidation:
        myproject: 25 new findings
      Run phren-consolidate when ready.
      </phren-notice>
      "
    `);
    expect(lastTrace().abstained).toBeNull();
  }, 30_000);
});
