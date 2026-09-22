import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import type { CliContext } from "../cli-registry.js";
import { withFileLock } from "../governance/locks.js";
import { archiveFinishedFanouts } from "../bridge/fanouts.js";
import { defaultPolicy, policySchema, pick, type Candidate, type Tier } from "./picker.js";
import { readUsage, recentProviderErrors } from "./usage.js";
import { createJob, jobsRoot, launch, listJobs, readJob, swiftBuildCount } from "./launcher.js";

export async function runFanout(args: string[], ctx: CliContext): Promise<number | void> {
  const [action, ...rest] = args, store = ctx.phrenPath();
  if (action === "usage") {
    console.log("Provider\tWindow\tUsed\tResets");
    for (const account of await readUsage()) {
      if (!account.windows.length) console.log(`${account.source}\t${account.message ?? "Usage unavailable"}`);
      for (const window of account.windows) console.log(`${account.source}\t${window.name}\t${window.usedPercent === undefined ? "unknown" : window.usedPercent + " percent"}\t${window.resetsAt ?? "unknown"}`);
    }
    return;
  }
  if (action === "list") { for (const job of listJobs(store)) console.log(`${job.id}\t${job.status}\t${job.provider}/${job.model}\t${job.taskLabel}`); return; }
  if (action === "archive") { if (rest.some(arg => arg !== "--dry-run")) throw new Error("Usage: phren fanout archive [--dry-run]"); console.log(await archiveFinishedFanouts({ ...process.env, PHREN_PATH: store }, { dryRun: rest.includes("--dry-run") })); return; }
  if (!["run", "resume", "review"].includes(action)) throw new Error("Usage: phren fanout run|usage|resume|review|list|archive");
  const previous = action === "run" ? undefined : readJob(store, rest.shift() ?? "");
  const flags: Record<string, string> = {}, extra: string[] = [];
  while (rest.length) {
    const key = rest.shift()!, value = rest.shift();
    if (!["--tier", "--provider", "--model", "--label", "--worktree", "--variant", "--extra"].includes(key) || !value) throw new Error(`Invalid fan-out option ${key}`);
    if (key === "--extra") extra.push(value); else flags[key.slice(2)] = value;
  }
  const tier = flags.tier ?? (action === "review" ? "review" : "narrow");
  if (!["narrow", "wide", "review"].includes(tier)) throw new Error("Choose tier narrow, wide or review.");
  if (previous && !previous.session) throw new Error("This job has no resumable session.");
  if (previous && flags.provider && flags.provider !== previous.provider) throw new Error("Resume must use the job's original provider.");
  if (previous && flags.worktree && path.resolve(flags.worktree) !== path.resolve(previous.worktree)) throw new Error("Resume must use the job's original worktree.");
  const label = flags.label ?? previous?.taskLabel, worktree = flags.worktree ?? previous?.worktree;
  if (!label || !worktree) throw new Error("phren fanout run needs --label and --worktree.");
  let prompt = action === "review" && process.stdin.isTTY ? "Review your changes for correctness and regressions. Report findings without editing files." : fs.readFileSync(0, "utf8");
  if (!prompt.trim() && action === "review") prompt = "Review your changes for correctness and regressions. Report findings without editing files.";
  if (!prompt.trim()) throw new Error("Provide a brief on stdin.");
  const file = path.join(store, ".config", "fanout.yaml");
  const policy = fs.existsSync(file) ? policySchema.parse(yaml.load(fs.readFileSync(file, "utf8"), { schema: yaml.CORE_SCHEMA })) : defaultPolicy;
  const usage = await readUsage(), errors = recentProviderErrors(), needsSwift = /\b(swift|xcodebuild|ios)\b/i.test(prompt);
  fs.mkdirSync(jobsRoot(store), { recursive: true, mode: 0o700 });
  const reserved = withFileLock(path.join(jobsRoot(store), "launch"), () => {
    const running = listJobs(store).filter(job => !fs.existsSync(path.join(jobsRoot(store), job.id, "exit.txt")));
    const chosen = pick({ policy, tier: tier as Tier, usage, errors, running, swiftBuilds: needsSwift ? swiftBuildCount() : 0, needsSwift,
      override: { provider: (flags.provider ?? previous?.provider) as Candidate["provider"] | undefined, model: flags.model ?? previous?.model } });
    console.log(chosen.reason);
    const options = { ...chosen, store, label, worktree, prompt, review: tier === "review", resume: previous?.session, variant: flags.variant, extra };
    return { options, reservation: createJob(options) };
  });
  return launch(reserved.options, reserved.reservation);
}
