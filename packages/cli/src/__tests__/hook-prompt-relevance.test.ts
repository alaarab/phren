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
  const run = (prompt: string, cwd: string) => {
    const result = spawnSync(process.execPath, [cli, "hook-prompt"], {
      input: JSON.stringify({ prompt, cwd, session_id: `relevance-${Math.random().toString(16).slice(2)}` }),
      env: { ...process.env, PHREN_PATH: store, PHREN_PROFILE: "personal", HOME: tmp.path, PHREN_FEATURE_AUTO_EXTRACT: "0" },
      encoding: "utf8", timeout: 60_000,
    });
    return result.stdout ?? "";
  };
  const injected = (output: string) => [...output.matchAll(/^\[([^\]]+)\] \(/gm)].map(match => match[1]);

  beforeAll(() => {
    tmp = makeTempDir("hook-prompt-relevance-");
    store = path.join(tmp.path, ".phren");
    workRepo = path.join(tmp.path, "Projects", "AudioPlugins");
    fs.mkdirSync(path.join(workRepo, ".git"), { recursive: true });
    const projects = ["global", "phren", "toolbridge", "designstudio", "stockview", "audioplugins"];
    write("profiles/personal.yaml", `name: personal\nprojects:\n${projects.map(name => `  - ${name}`).join("\n")}\n`);
    write("toolbridge/FINDINGS.md", "# toolbridge Findings\n\n- Each agent tool call in toolbridge records a sample event before execution.\n- The sample registry knows each agent by its session key.\n");
    write("designstudio/FINDINGS.md", "# designstudio Findings\n\n- The studio agent assigns sample render jobs to workers and reads their results.\n- Other studio agents know which sample render job is next.\n");
    write("phren/FINDINGS.md", "# phren Findings\n\n- The demo agent lists sessions from a sample registry before assigning jobs.\n");
    write("stockview/FINDINGS.md", "# stockview Findings\n\n- [pitfall] Deploying stockview.example.com: scripts/deploy.sh is the only deploy path; it checks, packages and uploads the demo.\n");
    write("audioplugins/reference/topics/audio.md", "# audio\n\n" + Array.from({ length: 40 }, (_, i) =>
      `- Audio device ${i}: push the buffer size on main thread before the next audio callback.`).join("\n") + "\n");
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
});
