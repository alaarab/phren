import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexForeignThread, foreignMeta } from "./codex-thread-origin.js";

const meta = (fields: string) => `{"timestamp":"2026-10-04T18:38:33Z","type":"session_meta","payload":{"id":"01a10973","cwd":"/tmp/x",${fields},"base_instructions":"${"x".repeat(8000)}"}}\n`;

describe("Codex callbacks from threads that are not the pane's conversation", () => {
  it("are a nested codex exec or a subagent, never the TUI's own thread", () => {
    expect(foreignMeta(meta('"originator":"codex_exec","cli_version":"0.160.0","source":"exec"'))).toBe(true);
    expect(foreignMeta(meta('"originator":"phren_hook","source":{"subagent":{"other":"guardian"}}'))).toBe(true);
    expect(foreignMeta(meta('"originator":"codex_exec","source":{"subagent":{"thread_spawn":{"parent_thread_id":"01a10985"}}}'))).toBe(true);
    expect(foreignMeta(meta('"originator":"phren_hook","source":"vscode"'))).toBe(false);
    expect(foreignMeta(meta('"originator":"codex_cli_rs","source":"cli"'))).toBe(false);
    expect(foreignMeta('{"type":"response_item","payload":{"source":"exec"}}')).toBe(false);
  });

  it("are read from the rollout's first row, and an unreadable one counts as the pane's own", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phren-rollout-"));
    try {
      const nested = path.join(root, "rollout-2026-10-04T18-38-33-01a10973.jsonl"), tui = path.join(root, "rollout-2026-10-04T18-01-12-01a10813.jsonl");
      await writeFile(nested, meta('"originator":"codex_exec","source":"exec"'));
      await writeFile(tui, meta('"originator":"phren_hook","source":"vscode"'));
      expect(await codexForeignThread(nested)).toBe(true);
      expect(await codexForeignThread(tui)).toBe(false);
      expect(await codexForeignThread(path.join(root, "rollout-missing.jsonl"))).toBe(false);
      expect(await codexForeignThread(path.join(root, "notes.jsonl"))).toBe(false);
      expect(await codexForeignThread(undefined)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
