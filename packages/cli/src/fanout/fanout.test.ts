import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../test-helpers.js";
import { defaultPolicy, pick } from "./picker.js";
import { parseProviderErrors } from "./usage.js";
import { adapters, createJob, launch, readJob } from "./launcher.js";
import { LoopWatchdog, stderrRefusal } from "./watchdog.js";
const now = Date.parse("2026-09-21T12:00:00Z");
const base = { policy: defaultPolicy, tier: "narrow" as const, usage: [], errors: [], running: [], swiftBuilds: 0, needsSwift: false, now };
let temp: ReturnType<typeof makeTempDir> | undefined;
afterEach(() => { temp?.cleanup(); vi.unstubAllEnvs(); });
describe("fan-out routing", () => {
  it("skips exhausted model windows and records the reason", () => {
    const chosen = pick({ ...base, usage: [{ source: "opencode-go", windows: [{ id: "opencode-go:mimo_v2_flash:5h", name: "mimo flash 5h", usedPercent: 100 }] }] });
    expect(chosen.provider).toBe("codex");
    expect(chosen.reason).toBe("chose codex/gpt-5.6-terra: opencode-go mimo flash 5h at 100 percent");
  });
  it("blocks a provider for thirty minutes after a recent refusal", () => {
    const errors = parseProviderErrors('ERROR 2026-09-21T11:45:00Z providerID=opencode-go error="Go usage limit exceeded"', now);
    expect(pick({ ...base, errors }).provider).toBe("codex");
    expect(pick({ ...base, errors, now: now + 16 * 60_000 }).provider).toBe("opencode");
    expect(parseProviderErrors('ERROR 2026-09-21T10:00:00Z providerID=openrouter error="Rate limit exceeded"', now)).toEqual([]);
  });
  it("keeps an exhausted window blocked until a valid reset has passed", () => {
    const usage = [{ source: "opencode-go" as const, windows: [{ id: "opencode-go:mimo_v2_flash:5h", name: "5h", usedPercent: 90, resetsAt: "invalid" }] }];
    expect(pick({ ...base, usage }).provider).toBe("codex");
    usage[0].windows[0].resetsAt = "2026-09-21T11:59:00Z";
    expect(pick({ ...base, usage }).provider).toBe("opencode");
  });
  it("enforces computer, provider and Swift caps even for explicit choices", () => {
    expect(() => pick({ ...base, running: Array(6).fill({ provider: "codex" }) })).toThrow("Computer concurrency");
    expect(() => pick({ ...base, swiftBuilds: 2, needsSwift: true })).toThrow("Swift build cap");
    expect(pick({ ...base, running: Array(4).fill({ provider: "opencode", model: "opencode-go/mimo-v2-flash" }) }).provider).toBe("codex");
    expect(() => pick({ ...base, override: { provider: "claude" } })).toThrow("no matching policy");
  });
});
it("owns each harness argv and resume semantics", () => {
  const options = { model: "model", worktree: "/work", job: "/job", review: true, resume: "session" };
  expect(adapters.codex.argv(options)).toEqual(["exec", "resume", "--json", "-o", "/job/final.txt", "-m", "model", "session", "-"]);
  expect(adapters.codex.argv({ ...options, resume: undefined })).toContain("read-only");
  // OpenCode serves and the launcher drives the session over HTTP.
  expect(adapters.opencode.argv(options)).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
  expect(adapters.claude.argv(options)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--model", "model", "--permission-mode", "plan", "--resume", "session"]);
});
it("writes the Hook job contract with private files and a resumable identity", () => {
  temp = makeTempDir("fanout-contract-");
  const options = { store: temp.path, provider: "codex" as const, model: "gpt-5.6-terra", label: "check", worktree: temp.path, prompt: "bounded brief", reason: "usage below threshold", resume: "00000000-0000-4000-8000-000000000001" };
  const { job, manifest } = createJob(options, { CODEX_THREAD_ID: options.resume });
  expect(readJob(temp.path, manifest.id)).toMatchObject({ parent: { provider: "codex", session: options.resume }, resumes: options.resume, reason: options.reason, status: "running", eventLog: "events.jsonl" });
  expect(fs.readFileSync(path.join(job, "prompt.txt"), "utf8")).toBe(options.prompt);
  expect(fs.statSync(path.join(job, "prompt.txt")).mode & 0o777).toBe(0o600);
});
it("detects sixty repeated calls with canonical input ordering but allows varied work", () => {
  const watch = new LoopWatchdog();
  for (let i = 0; i < 59; i++) watch.observe({ type: "tool_use", part: { tool: "glob", state: { input: { b: 2, a: 1 } } } });
  expect(watch.reason()).toBeUndefined();
  watch.observe({ type: "tool_use", part: { tool: "glob", state: { input: { a: 1, b: 2 } } } });
  expect(watch.reason()).toContain("1 distinct inputs");
  for (let i = 0; i < 3; i++) watch.observe({ type: "tool_use", part: { tool: "read", state: { input: { file: i } } } });
  expect(watch.reason()).toBeUndefined();
  expect(stderrRefusal("permission requested: external_directory (/tmp/work); auto-rejecting")).toMatchObject({ type: "external_directory", pattern: "/tmp/work" });
});

it("finalizes a zero-exit refused worker as failed and captures its session", async () => {
  temp = makeTempDir("fanout-refused-");
  const bin = path.join(temp.path, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh
cat > /dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"00000000-0000-4000-8000-000000000002"}'
printf '%s\\n' 'permission requested: external_directory (/tmp/work); auto-rejecting' >&2
`, { mode: 0o700 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  const options = { store: temp.path, provider: "codex" as const, model: "gpt-5.6-terra", label: "refusal", worktree: temp.path, prompt: "brief", reason: "eligible" };
  const reservation = createJob(options);
  expect(await launch(options, reservation)).toBe(1);
  expect(readJob(temp.path, reservation.manifest.id)).toMatchObject({ status: "failed", exitCode: 0, session: "00000000-0000-4000-8000-000000000002" });
  expect(JSON.parse(fs.readFileSync(path.join(reservation.job, "blocked.json"), "utf8"))).toMatchObject({ type: "external_directory", pattern: "/tmp/work" });
  expect(fs.readFileSync(path.join(reservation.job, "exit.txt"), "utf8")).toBe("0\n");
});
