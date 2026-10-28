import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearProjectConfigCache } from "../project-config.js";
import { register } from "../tools/helper.js";
import { setAccountSettings, setComputerAllowedPools, setProjectAllowedPools } from "./account-pools.js";
import { clearAccountCaches } from "./claude-accounts.js";
import { addClaudeCredit, homeSessionCosts } from "./claude-credits.js";
import { helperFor, helperRunsFile, runHelper } from "./helper.js";

// A stand-in `claude`: echoes what it was started with as Claude's --output-format json answer, or misbehaves on FAKE_MODE.
const FAKE = `#!/usr/bin/env node
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const mode = process.env.FAKE_MODE || "ok";
  if (mode === "hang") { setTimeout(() => {}, 60_000); return; }
  if (mode === "fail") { process.stderr.write("Invalid API key"); process.exit(1); }
  const seen = { args: process.argv.slice(2), cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    apiKey: process.env.ANTHROPIC_API_KEY ?? null, input };
  process.stdout.write(JSON.stringify({ type: "result", is_error: mode === "error", result: JSON.stringify(seen),
    session_id: "0f8a2b6c-1d3e-4f5a-9b7c-8d6e5f4a3b2c", total_cost_usd: 0.0125 }));
});
`;

let home = "", store = "", bin = "", work = "";
const env = (extra: Record<string, string> = {}) => ({ ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, ...extra });
const seen = (output: string) => JSON.parse(output) as { args: string[]; cwd: string; configDir: string | null; apiKey: string | null; input: string };
const config = (text: string) => writeFileSync(path.join(store, "client-a/phren.project.yaml"), text);

describe.skipIf(process.platform === "win32")("helper runs", () => {
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "phren-helper-"));
    store = path.join(home, "store"); bin = path.join(home, "bin"); work = path.join(home, "work");
    vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
    clearAccountCaches(); clearProjectConfigCache();
    for (const dir of [path.join(home, ".claude"), path.join(home, ".claude-api"), path.join(store, "client-a"), bin, work]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(home, ".claude-api", ".claude.json"), "{}");
    writeFileSync(path.join(bin, "claude"), FAKE); chmodSync(path.join(bin, "claude"), 0o755);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  it("refuses a project with no helper, an unknown or off account, a bad model and a pool the project or computer leaves out", async () => {
    expect(() => helperFor(store, "client-a")).toThrow(/no helper account: set helper/);
    config("helper: { account: ghost }\n");
    expect(() => helperFor(store, "client-a")).toThrow(/no Claude account "ghost"/);
    config("helper: { account: api, model: 'haiku; rm' }\n");
    expect(() => helperFor(store, "client-a")).toThrow(/helper.model/);
    config("helper: { account: api }\n");
    expect(helperFor(store, "client-a")).toMatchObject({ account: "api", model: "haiku" });
    await setAccountSettings("api", { role: "off" });
    expect(() => helperFor(store, "client-a")).toThrow(/role is off/);
    await setAccountSettings("api", { role: "helpers" });
    setProjectAllowedPools(store, "client-a", ["client-a"]);
    expect(() => helperFor(store, "client-a")).toThrow(/api \(no pool\) is not in project client-a's allowed pools: client-a/);
    await setAccountSettings("api", { pool: "client-a" });
    expect(helperFor(store, "client-a")).toMatchObject({ account: "api", pool: "client-a" });
    await setComputerAllowedPools(["personal"]);
    expect(() => helperFor(store, "client-a")).toThrow(/pool client-a\) is not in this computer's allowed pools: personal/);
  });

  it("runs claude -p under the helper's home and model in the lead's folder, and records the run and its cost", async () => {
    config("helper: { account: api, model: claude-haiku-5-5 }\n");
    await addClaudeCredit("api", { amount: "50" });
    const choice = helperFor(store, "client-a");
    // The lead's own login must not leak into the helper.
    const result = await runHelper(choice, { prompt: "Summarize README.md", cwd: work,
      env: env({ CLAUDE_CONFIG_DIR: path.join(home, ".claude-lead"), ANTHROPIC_API_KEY: "sk-lead" }) });
    expect(result).toMatchObject({ ok: true, project: "client-a", account: "api", model: "claude-haiku-5-5", costUSD: 0.0125, sessionId: "0f8a2b6c-1d3e-4f5a-9b7c-8d6e5f4a3b2c" });
    const run = seen(result.output);
    expect(run.args).toEqual(["-p", "--model", "claude-haiku-5-5", "--output-format", "json"]);
    expect(run).toMatchObject({ configDir: path.join(home, ".claude-api"), apiKey: null, input: "Summarize README.md" });
    expect(realpathSync(run.cwd)).toBe(realpathSync(work));
    expect(homeSessionCosts(choice.home)["0f8a2b6c-1d3e-4f5a-9b7c-8d6e5f4a3b2c"]?.costUSD).toBe(0.0125);
    const lines = readFileSync(helperRunsFile(), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toEqual([expect.objectContaining({ project: "client-a", account: "api", model: "claude-haiku-5-5", ok: true, costUSD: 0.0125 })]);
    expect(readFileSync(helperRunsFile(), "utf8")).not.toContain("README");
  });

  it("runs the default account without CLAUDE_CONFIG_DIR even when the lead has one, and lets edits through only when asked", async () => {
    config("helper: { account: default }\n");
    const result = await runHelper(helperFor(store, "client-a", env({ CLAUDE_CONFIG_DIR: path.join(home, ".claude-api") })),
      { prompt: "x", cwd: work, allowEdits: true, env: env({ CLAUDE_CONFIG_DIR: path.join(home, ".claude-api") }) });
    expect(seen(result.output)).toMatchObject({ configDir: null, args: ["-p", "--model", "haiku", "--output-format", "json", "--permission-mode", "acceptEdits"] });
  });

  it("reports a failed, erroring, missing or overlong claude without throwing", async () => {
    config("helper: { account: api }\n");
    const choice = helperFor(store, "client-a");
    expect(await runHelper(choice, { prompt: "x", cwd: work, env: env({ FAKE_MODE: "fail" }) })).toMatchObject({ ok: false, output: "Invalid API key" });
    expect(await runHelper(choice, { prompt: "x", cwd: work, env: env({ FAKE_MODE: "error" }) })).toMatchObject({ ok: false });
    expect(await runHelper(choice, { prompt: "x", cwd: work, env: { ...process.env, PATH: path.join(home, "nowhere") } }))
      .toMatchObject({ ok: false, output: "claude is not on this computer's PATH." });
    const hung = await runHelper(choice, { prompt: "x", cwd: work, timeoutSeconds: 1, env: env({ FAKE_MODE: "hang" }) });
    expect(hung).toMatchObject({ ok: false, timedOut: true, output: expect.stringMatching(/ran past 1s/) });
    expect(readFileSync(helperRunsFile(), "utf8").trim().split("\n")).toHaveLength(4);
    // No credit entered: nothing goes into the cost ledger.
    expect(existsSync(path.join(home, "bridge/usage/claude-cost-api.json"))).toBe(false);
  });

  it("answers through the MCP tool, refusing with the reason", async () => {
    let handler: ((input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    register({ registerTool: (_name: string, _config: unknown, fn: typeof handler) => { handler = fn; } } as never, { phrenPath: store, profile: "" } as never);
    const call = async (input: Record<string, unknown>) => JSON.parse((await handler!(input)).content[0].text) as { ok: boolean; error?: string; message?: string; data?: { output: string } };
    expect(await call({ prompt: "x", project: "client-a", cwd: work })).toMatchObject({ ok: false, error: expect.stringMatching(/no helper account/) });
    expect(await call({ prompt: "x", project: "client-a", cwd: "relative" })).toMatchObject({ ok: false, error: "cwd is an absolute path." });
    config("helper: { account: api }\n");
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    const answer = await call({ prompt: "hello", project: "client-a", cwd: work });
    expect(answer).toMatchObject({ ok: true, message: expect.stringMatching(/^Helper replied \(api, haiku, \d+s, \$0\.0125\)\.$/) });
    expect(seen(answer.data!.output).input).toBe("hello");
  });
});
