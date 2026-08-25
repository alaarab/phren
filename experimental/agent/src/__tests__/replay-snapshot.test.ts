import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ReplayProvider, ReplayExhaustedError } from "../providers/replay.js";
import { resolveProvider } from "../providers/resolve.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "replay-shell-session.events.jsonl");
const AGENT_BIN = path.resolve(here, "../../dist/bin.js");

describe("ReplayProvider", () => {
  it("loads scripted responses from a recorded event log", () => {
    const provider = ReplayProvider.fromEventLog(FIXTURE);
    expect(provider.name).toBe("replay");
    expect(provider.remaining).toBe(2);
  });

  it("replays responses in order and records every request", async () => {
    const provider = ReplayProvider.fromEventLog(FIXTURE);

    const first = await provider.chat("sys", [{ role: "user", content: "go" }], []);
    expect(first.stop_reason).toBe("tool_use");
    expect(first.content[0]).toMatchObject({ type: "tool_use", name: "shell" });

    const second = await provider.chat("sys", [], []);
    expect(second.stop_reason).toBe("end_turn");
    expect(second.content[0]).toMatchObject({ type: "text" });

    expect(provider.requests).toHaveLength(2);
    expect(provider.remaining).toBe(0);
    provider.assertFullyConsumed();
  });

  it("throws ReplayExhaustedError when the loop diverges past the script", async () => {
    const provider = ReplayProvider.fromMessages([
      { content: [{ type: "text", text: "only one" }] },
    ]);
    await provider.chat("s", [], []);
    await expect(provider.chat("s", [], [])).rejects.toThrow(ReplayExhaustedError);
  });

  it("assertFullyConsumed throws when responses were left over", async () => {
    const provider = ReplayProvider.fromEventLog(FIXTURE);
    await provider.chat("s", [], []);
    expect(() => provider.assertFullyConsumed()).toThrow(/1\/2/);
  });

  it("resolveProvider returns a replay provider when PHREN_AGENT_REPLAY is set", () => {
    const saved = process.env.PHREN_AGENT_REPLAY;
    process.env.PHREN_AGENT_REPLAY = FIXTURE;
    try {
      const provider = resolveProvider();
      expect(provider.name).toBe("replay");
    } finally {
      if (saved === undefined) delete process.env.PHREN_AGENT_REPLAY;
      else process.env.PHREN_AGENT_REPLAY = saved;
    }
  });
});

// ── Built-binary snapshot: the real agent, keyless, against the fixture ──────

describe.skipIf(!fs.existsSync(AGENT_BIN))("replay snapshot (built binary)", () => {
  let storeDir: string;
  let workDir: string;

  beforeEach(() => {
    storeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-replay-store-")));
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-replay-work-")));
    fs.writeFileSync(path.join(storeDir, "phren.root.yaml"), "version: 1\n");
  });

  afterEach(() => {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("reproduces the recorded session end-to-end with no API keys", async () => {
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
      (resolve, reject) => {
        execFile(
          process.execPath,
          [AGENT_BIN, "--yolo", "--no-subagents", "Run echo replay-fixture-7 and report the marker."],
          {
            cwd: workDir,
            timeout: 60_000,
            env: {
              ...process.env,
              PHREN_AGENT_REPLAY: FIXTURE,
              PHREN_PATH: storeDir,
              // Make sure no real credentials leak into the run
              OPENAI_API_KEY: "",
              OPENROUTER_API_KEY: "",
              ANTHROPIC_API_KEY: "",
              PHREN_OLLAMA_URL: "off",
              NO_COLOR: "1",
            },
          },
          (err, stdout, stderr) => {
            if (err && (err as { killed?: boolean }).killed) reject(err);
            else resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? (err as { code?: number }).code ?? 1 : 0 });
          },
        );
      },
    );

    // The scripted final answer made it to stdout, which means the scripted
    // tool call actually executed (real shell) and the loop consumed the
    // recording exactly.
    expect(stderr).not.toContain("Replay exhausted");
    expect(code).toBe(0);
    expect(stdout).toContain("Replay complete: the marker is replay-fixture-7");
  }, 90_000);
});
