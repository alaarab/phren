import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FINDING_SENSITIVITY_CONFIG } from "../cli/config.js";
import { makeTempDir } from "../test-helpers.js";

/** The prompt hook end to end, as Claude Code runs it: {prompt, cwd,
 * session_id} on stdin, the injected context on stdout. The owner's real
 * prompts that used to inject noise must inject nothing; a real question
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
    workRepo = path.join(tmp.path, "Projects", "Max4LivePlugins");
    fs.mkdirSync(path.join(workRepo, ".git"), { recursive: true });
    const projects = ["global", "phren", "livemcp", "objectstudio", "alphalens", "max4liveplugins"];
    write("profiles/personal.yaml", `name: personal\nprojects:\n${projects.map(name => `  - ${name}`).join("\n")}\n`);
    write("livemcp/FINDINGS.md", "# livemcp Findings\n\n- QA pass: every agent tool call in the livemcp harness is logged before it runs.\n- The phren MCP server knows each agent by session id.\n");
    write("objectstudio/FINDINGS.md", "# objectstudio Findings\n\n- Delegation: the studio agent hands work to workers and reviews their diffs.\n- Other agents in the studio know the render queue.\n");
    write("phren/FINDINGS.md", "# phren Findings\n\n- The conductor lists live sessions across computers with live_sessions.\n");
    write("alphalens/FINDINGS.md", "# alphalens Findings\n\n- [pitfall] Deploying alphalens.net: apps/bot/deploy.sh is the only deploy path; it pulls, builds and restarts the bot.\n");
    write("max4liveplugins/reference/topics/audio.md", "# audio\n\n" + Array.from({ length: 40 }, (_, i) =>
      `- Audio device ${i}: push the buffer size on main thread before the next audio callback.`).join("\n") + "\n");
    write("global/FINDINGS.md", "# global Findings\n\n- Push to main only after the full suite passes on both machines.\n");
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
    expect(injected(run("Do all those agents know about each other those Phren agent", store))).toEqual([]);
  });

  it("injects nothing for 'Push to main on both' in a project", () => {
    expect(injected(run("Push to main on both", workRepo))).toEqual([]);
  });

  it("injects nothing for 'Yes'", () => {
    expect(injected(run("Yes", store))).toEqual([]);
  });

  it("still finds the deploy finding for a real question", () => {
    const output = run("how do I deploy alphalens", store);
    expect(injected(output)).toContain("alphalens/FINDINGS.md");
    expect(output).toContain("deploy.sh is the only deploy path");
    expect(output).toContain(`[phren finding-sensitivity=balanced] ${FINDING_SENSITIVITY_CONFIG.balanced.agentInstruction}`);
  });
});
