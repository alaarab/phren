#!/usr/bin/env node
// Real-task benchmark: runs the built phren-agent headless against small
// fixture repos and judges each result with the repo's own tests.
//
//   node scripts/bench/run.mjs --provider openai-codex [--model gpt-5.4]
//        [--task fix-failing-test,...] [--runs 1] [--max-turns 30]
//        [--output results.json] [--keep]
//   node scripts/bench/run.mjs --self-check     # fixtures fail before any agent runs
//
// Each run copies a fixture into a fresh temp git repo, points PHREN_PATH at an
// empty temporary store (the owner's memory is never read), and runs
//   phren-agent --output-format json --yolo --no-subagents <task>
// A run passes when the fixture's check command exits 0, every file listed in
// "unchanged" is byte-identical, and an "absent" pattern no longer appears.
// Paid providers spend real money: nothing here picks a provider for you.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const agentBin = path.resolve(here, "../../dist/bin.js");

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(name);

const allTasks = fs.readdirSync(fixturesDir).filter((d) => fs.existsSync(path.join(fixturesDir, d, "task.json"))).sort();
const tasks = (opt("--task") ?? allTasks.join(",")).split(",").filter(Boolean);
for (const t of tasks) if (!allTasks.includes(t)) throw new Error(`unknown task ${t}; have ${allTasks.join(", ")}`);

function prepare(task) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `phren-bench-${task}-`)));
  fs.cpSync(path.join(fixturesDir, task), dir, { recursive: true });
  const spec = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
  fs.rmSync(path.join(dir, "task.json"));
  const git = (...a) => spawnSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=bench@example.invalid", "-c", "user.name=bench", "commit", "-qm", "fixture");
  const snapshots = Object.fromEntries((spec.unchanged ?? []).map((f) => [f, fs.readFileSync(path.join(dir, f))]));
  return { dir, spec, snapshots };
}

function judge({ dir, spec, snapshots }) {
  const reasons = [];
  const check = spawnSync(spec.check[0], spec.check.slice(1), { cwd: dir, encoding: "utf8", timeout: 120_000 });
  if (check.status !== 0) reasons.push(`check failed: ${(check.stdout + check.stderr).split("\n").filter((l) => /fail|not ok|Error/i.test(l)).slice(0, 3).join(" | ") || `exit ${check.status}`}`);
  for (const [f, before] of Object.entries(snapshots)) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p) || !fs.readFileSync(p).equals(before)) reasons.push(`${f} was modified`);
  }
  if (spec.absent) {
    const hit = spawnSync("grep", ["-rn", spec.absent.pattern, spec.absent.dir], { cwd: dir, encoding: "utf8" });
    if (hit.status === 0) reasons.push(`"${spec.absent.pattern}" still present: ${hit.stdout.split("\n")[0]}`);
  }
  return { pass: reasons.length === 0, reasons };
}

if (flag("--self-check")) {
  let ok = true;
  for (const task of tasks) {
    const prepared = prepare(task);
    const verdict = judge(prepared);
    console.log(`${task}: ${verdict.pass ? "UNEXPECTED PASS" : "fails before the agent runs (good)"}`);
    if (verdict.pass) ok = false;
    fs.rmSync(prepared.dir, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
}

const provider = opt("--provider");
if (!provider) {
  console.error("Pass --provider (e.g. openai-codex). The harness never chooses a paid provider for you.");
  process.exit(2);
}
if (!fs.existsSync(agentBin)) {
  console.error(`Build first: pnpm --filter @phren/agent build (missing ${agentBin})`);
  process.exit(2);
}
const model = opt("--model");
const runs = Number(opt("--runs", "1"));
const maxTurns = opt("--max-turns", "30");
const timeoutMs = Number(opt("--timeout", "600")) * 1000;

function runAgent(dir, task, store) {
  return new Promise((resolve) => {
    const args = [agentBin, "--output-format", "json", "--yolo", "--no-subagents", "--max-turns", maxTurns, "--provider", provider];
    if (model) args.push("--model", model);
    if (opt("--reasoning")) args.push("--reasoning", opt("--reasoning"));
    args.push(task);
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: dir,
      env: { ...process.env, PHREN_PATH: store, PHREN_INTRO: "off", NO_COLOR: "1", PHREN_AGENT_USER_RULES: "off" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      let result = null;
      try { result = JSON.parse(stdout.trim().split("\n").pop()); } catch { /* reported below */ }
      resolve({ code, result, stderr, seconds: (Date.now() - started) / 1000 });
    });
  });
}

const rows = [];
for (const task of tasks) {
  for (let n = 0; n < runs; n++) {
    const prepared = prepare(task);
    const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-bench-store-")));
    fs.writeFileSync(path.join(store, "phren.root.yaml"), "version: 1\n");
    process.stderr.write(`[bench] ${task} run ${n + 1}/${runs} (${provider}${model ? `/${model}` : ""}) in ${prepared.dir}\n`);
    const out = await runAgent(prepared.dir, prepared.spec.task, store);
    const verdict = judge(prepared);
    const row = {
      task,
      run: n + 1,
      provider,
      model: out.result?.model ?? model ?? null,
      pass: verdict.pass,
      reasons: verdict.reasons,
      agent_exit: out.code,
      agent_subtype: out.result?.subtype ?? "no-result",
      turns: out.result?.num_turns ?? null,
      tool_calls: out.result?.tool_calls ?? null,
      input_tokens: out.result?.usage?.input_tokens ?? null,
      output_tokens: out.result?.usage?.output_tokens ?? null,
      cost_usd: out.result?.total_cost_usd ?? null,
      seconds: Math.round(out.seconds * 10) / 10,
    };
    if (out.result?.error) row.error = out.result.error.slice(0, 300);
    if (!out.result) row.stderr_tail = out.stderr.split("\n").slice(-5).join("\n");
    rows.push(row);
    process.stderr.write(`[bench] ${task}: ${row.pass ? "PASS" : `FAIL (${row.reasons.join("; ")})`} ${row.seconds}s, ${row.turns} turns\n`);
    if (!flag("--keep")) fs.rmSync(prepared.dir, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
}

const passed = rows.filter((r) => r.pass).length;
console.log(`\n| Task | Provider / model | Result | Turns | Tool calls | Tokens in/out | Seconds |`);
console.log(`| --- | --- | --- | ---: | ---: | ---: | ---: |`);
for (const r of rows) {
  console.log(`| ${r.task} | ${r.provider} / ${r.model ?? "default"} | ${r.pass ? "pass" : `fail: ${r.reasons.join("; ")}`} | ${r.turns ?? "-"} | ${r.tool_calls ?? "-"} | ${r.input_tokens ?? "-"} / ${r.output_tokens ?? "-"} | ${r.seconds} |`);
}
console.log(`\n${passed}/${rows.length} passed`);
const output = opt("--output");
if (output) fs.writeFileSync(output, `${JSON.stringify({ date: new Date().toISOString(), provider, model, rows }, null, 2)}\n`);
process.exit(passed === rows.length ? 0 : 1);
