import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FINDING_SENSITIVITY_CONFIG } from "../cli/config.js";
import { makeTempDir } from "../test-helpers.js";

/** The prompt hook end to end, as Claude Code runs it: {prompt, cwd,
 * session_id} on stdin, the injected context on stdout. Synthetic conversational
 * prompts must inject nothing; a specific question
 * must still find its finding. Relevance comes from scoring (two keywords
 * in one bullet, weighed by rarity), never a list of skipped words. */
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

describe.skipIf(!fs.existsSync(cli))("hook-prompt relevance", () => {
  let tmp: { path: string; cleanup: () => void };
  let store: string, workRepo: string;

  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(store, file)), { recursive: true });
    fs.writeFileSync(path.join(store, file), text);
  };
  const env = () => ({ ...process.env, PHREN_PATH: store, PHREN_PROFILE: "personal", HOME: tmp.path, PHREN_FEATURE_AUTO_EXTRACT: "0" });
  const run = (prompt: string, cwd: string, session = `relevance-${Math.random().toString(16).slice(2)}`) => {
    const result = spawnSync(process.execPath, [cli, "hook-prompt"], {
      input: JSON.stringify({ prompt, cwd, session_id: session }),
      env: env(), encoding: "utf8", timeout: 60_000,
    });
    return result.stdout ?? "";
  };
  const injected = (output: string) => [...output.matchAll(/^\[([^\]]+)\] \(/gm)].map(match => match[1]);

  beforeAll(() => {
    tmp = makeTempDir("hook-prompt-relevance-");
    store = path.join(tmp.path, ".phren");
    workRepo = path.join(tmp.path, "Projects", "MyProject");
    fs.mkdirSync(path.join(workRepo, ".git"), { recursive: true });
    const projects = ["global", "phren", "toolbridge", "designstudio", "stockview", "myproject"];
    write("profiles/personal.yaml", `name: personal\nprojects:\n${projects.map(name => `  - ${name}`).join("\n")}\n`);
    write("toolbridge/FINDINGS.md", "# toolbridge Findings\n\n- Each agent tool call in toolbridge records a sample event before execution.\n- The sample registry knows each agent by its session key.\n");
    write("designstudio/FINDINGS.md", "# designstudio Findings\n\n- The studio agent assigns sample render jobs to workers and reads their results.\n- Other studio agents know which sample render job is next.\n");
    write("phren/FINDINGS.md", "# phren Findings\n\n- The demo agent lists sessions from a sample registry before assigning jobs.\n");
    write("stockview/FINDINGS.md", "# stockview Findings\n\n- [pitfall] Deploying stockview.example.com: scripts/deploy.sh is the only deploy path; it checks, packages and uploads the demo.\n");
    write("myproject/reference/topics/rendering.md", "# rendering\n\n" + Array.from({ length: 40 }, (_, i) =>
      `- Render device ${i}: push the frame size on main thread before the next render callback.`).join("\n") + "\n");
    write("global/FINDINGS.md", "# global Findings\n\n- Push sample notes to main once both demo checks finish.\n");
    // A store's everyday words: agents, pushes, main, knowing, in note after
    // note, as in any real store. That is what makes them common.
    const everyday = ["the agent should push the change to main", "each agent needs to know its session",
      "phren agents push notes after main merges", "we know the agent reads main first"];
    for (let i = 0; i < 60; i++) {
      write(`${projects[i % projects.length]}/reference/notes-${i}.md`,
        `# notes ${i}\n\n- ${everyday[i % everyday.length]} (note ${i}).\n- Topic ${i}: widget ${i} settings.\n`);
    }
  });
  afterAll(() => tmp?.cleanup());

  it("injects nothing for the conductor's question about its agents", () => {
    expect(injected(run("Do these agents know about the other agents", store))).toEqual([]);
  });

  it("injects nothing for 'Push these notes to main' in a project", () => {
    expect(injected(run("Push these notes to main", workRepo))).toEqual([]);
  });

  it("injects nothing for 'Yes'", () => {
    expect(injected(run("Yes", store))).toEqual([]);
  });

  it("still finds the deploy finding for a real question", () => {
    const output = run("how do I deploy stockview", store);
    expect(injected(output)).toContain("stockview/FINDINGS.md");
    expect(output).toContain("deploy.sh is the only deploy path");
    expect(output).toContain(`[phren finding-sensitivity=balanced] ${FINDING_SENSITIVITY_CONFIG.balanced.agentInstruction}`);
  });

  it("skips a background agent's result, even one asking the same question", () => {
    expect(run("<task-notification><task-id>a1</task-id><status>completed</status><result>how do I deploy stockview</result></task-notification>", store)).toBe("");
  });

  it.each([
    ["a sub-agent hand-back", '<agent-message from="worker-1">\nhow do I deploy stockview\n</agent-message>'],
    ["another session's message", '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="lead-1">\nhow do I deploy stockview\n</cross-session-message>'],
    ["an idle notice", '[Cross-session idle notice] "lead-1", which you asked to be notified about, is idle now: how do I deploy stockview'],
  ])("skips %s, even one asking the same question", (_label, prompt) => {
    expect(run(prompt, store)).toBe("");
  });

  it("writes one recall trace line per prompt: injected, abstained or skipped", () => {
    const file = path.join(store, ".runtime", "recall-trace.jsonl");
    const read = () => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const before = read().length;
    run("how do I deploy stockview", store);
    run("Push these notes to main", workRepo);
    run('<agent-message from="worker-1">how do I deploy stockview</agent-message>', store);
    const [injectedLine, abstainedLine, skippedLine] = read().slice(before);
    expect(injectedLine.abstained).toBeNull();
    expect(injectedLine.injected.map((row: { path: string }) => row.path)).toContain("stockview/FINDINGS.md");
    expect(injectedLine.floor.some((row: { passed: boolean; matched: string[] }) => row.passed && row.matched.length >= 2)).toBe(true);
    expect(abstainedLine.abstained).toBeTruthy();
    expect(abstainedLine.injected).toEqual([]);
    expect(skippedLine).toMatchObject({ skipped: "machine-prompt" });
  });

  it("still answers the owner when a pasted block quotes an agent's message", () => {
    const output = run('how do I deploy stockview\n<pasted_content id="1">\n<agent-message from="worker-1">done</agent-message>\n</pasted_content id="1">', store);
    expect(injected(output)).toContain("stockview/FINDINGS.md");
  });

  it("injects a bullet once per session, again after 12 other prompts or once the conversation is compacted", () => {
    const session = "repeat-session";
    const deploy = (id = session) => run("how do I deploy stockview", store, id).includes("deploy.sh is the only deploy path");
    expect(deploy()).toBe(true); // prompt 1
    expect(deploy()).toBe(false); // prompt 2: the agent already has it
    expect(deploy("another-session")).toBe(true);
    for (let i = 3; i <= 12; i++) run("Push these notes to main", workRepo, session);
    expect(deploy()).toBe(false); // prompt 13: still within 12 prompts of the injection
    expect(deploy()).toBe(true); // prompt 14
    expect(deploy()).toBe(false);
    spawnSync(process.execPath, [cli, "hook-session-start"], {
      input: JSON.stringify({ session_id: session, source: "compact", cwd: store }),
      env: { ...env(), PHREN_FEATURE_DAILY_MAINTENANCE: "0" }, encoding: "utf8", timeout: 60_000,
    });
    expect(deploy()).toBe(true);
  }, 180_000);
});
