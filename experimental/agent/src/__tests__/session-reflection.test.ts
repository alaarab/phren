import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PhrenContext } from "../memory/context.js";
import type { LlmProvider, LlmResponse } from "../providers/types.js";
import { writeSessionNote } from "../memory/session.js";
import { evolveProjectContext } from "../memory/project-context.js";
import { listNotes } from "@phren/cli/data/notes";

describe("session-end mining and session notes", () => {
  let storeDir: string;
  const project = "mining";
  const savedPhrenPath = process.env.PHREN_PATH;

  function ctx(): PhrenContext {
    return { phrenPath: storeDir, profile: "", project };
  }

  beforeEach(() => {
    storeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-mine-")));
    fs.writeFileSync(path.join(storeDir, "phren.root.yaml"), "version: 1\n");
    fs.mkdirSync(path.join(storeDir, project), { recursive: true });
    fs.writeFileSync(path.join(storeDir, project, "FINDINGS.md"), `# ${project} Findings\n`);
    process.env.PHREN_PATH = storeDir;
  });

  afterEach(() => {
    if (savedPhrenPath === undefined) delete process.env.PHREN_PATH;
    else process.env.PHREN_PATH = savedPhrenPath;
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it("writes a searchable session note with session id, task, and outcome", () => {
    writeSessionNote(ctx(), {
      sessionId: "abcd1234-5678",
      task: "fix the flaky auth test",
      outcome: "Root-caused the race in token refresh; fixed and verified.",
    });

    const notes = listNotes(storeDir, project);
    expect(notes.ok).toBe(true);
    const texts = (notes.data ?? []).map((n) => n.text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("[agent session abcd1234]");
    expect(texts[0]).toContain("task: fix the flaky auth test");
    expect(texts[0]).toContain("outcome: Root-caused the race");
  });

  it("does nothing without a project or content, and never throws", () => {
    writeSessionNote({ ...ctx(), project: null }, { task: "x", outcome: "y" });
    writeSessionNote(ctx(), { sessionId: "only-id" });
    const notes = listNotes(storeDir, project);
    expect(notes.data ?? []).toHaveLength(0);
  });

  it("evolveProjectContext appends bullets and routes knowledge by confidence", async () => {
    const reflectionResponse = `- The wasm loader requires node 20\n- Tests must run from the repo root\n\n## Knowledge\n\`\`\`json\n{"items":[{"text":"The auth token refresh uses the OLD refresh token, not the access token","confidence":0.9,"kind":"gotcha"},{"text":"The retry helper might be duplicating backoff behaviour","confidence":0.6,"kind":"finding"}]}\n\`\`\``;
    const provider: LlmProvider = {
      name: "fake",
      async chat(): Promise<LlmResponse> {
        return { content: [{ type: "text", text: reflectionResponse }], stop_reason: "end_turn" };
      },
    };

    await evolveProjectContext(ctx(), provider, [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "did the thing" },
    ], { sessionId: "sess-mine" });

    // Bullets landed in agent-context.md WITHOUT the knowledge section
    const agentCtx = fs.readFileSync(path.join(storeDir, project, "agent-context.md"), "utf-8");
    expect(agentCtx).toContain("wasm loader requires node 20");
    expect(agentCtx).not.toContain("## Knowledge");
    expect(agentCtx).not.toContain("confidence");

    // High-confidence item promoted to FINDINGS.md with provenance
    const findings = fs.readFileSync(path.join(storeDir, project, "FINDINGS.md"), "utf-8");
    expect(findings).toContain("OLD refresh token");
    expect(findings).toContain("session:sess-mine");

    // Mid-confidence item queued for review
    const review = fs.readFileSync(path.join(storeDir, project, "review.md"), "utf-8");
    expect(review).toContain("duplicating backoff");
  });

  it("evolveProjectContext survives a provider failure silently", async () => {
    const provider: LlmProvider = {
      name: "broken",
      async chat() { throw new Error("down"); },
    };
    await expect(
      evolveProjectContext(ctx(), provider, [{ role: "user", content: "x" }], { sessionId: "s" }),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(storeDir, project, "agent-context.md"))).toBe(false);
  });
});
