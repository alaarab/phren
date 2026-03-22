import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import type { McpContext } from "../tools/types.js";

// ── Shared mocks for CLI extract path ───────────────────────────────────────

vi.mock("../utils.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    runGit: vi.fn(),
  };
});

vi.mock("../shared.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    debugLog: vi.fn(),
    appendAuditLog: vi.fn(),
    EXEC_TIMEOUT_MS: 5000,
    getPhrenPath: () => "/tmpphren-proactivity-test",
  };
});

vi.mock("../shared/governance.js", () => ({
  appendReviewQueue: vi.fn(() => ({ ok: true, data: 1 })),
  getRetentionPolicy: vi.fn(() => ({ autoAcceptThreshold: 0.5 })),
  recordFeedback: vi.fn(),
  flushEntryScores: vi.fn(),
  entryScoreKey: vi.fn(() => "score-key"),
}));

vi.mock("../finding/journal.js", () => ({
  appendFindingJournal: vi.fn(() => ({ ok: true, data: "journal" })),
  compactFindingJournals: vi.fn(() => ({ added: 0, skipped: 0, failed: 0 })),
}));

vi.mock("../hooks.js", () => ({
  commandExists: vi.fn(() => false),
}));

// ── Shared mocks for MCP extract path ───────────────────────────────────────

vi.mock("../shared/ollama.js", () => ({
  checkOllamaAvailable: vi.fn(async () => true),
  checkModelAvailable: vi.fn(async () => true),
  generateText: vi.fn(async () => '["[pattern] Retry socket setup after ECONNRESET"]'),
  getOllamaUrl: vi.fn(() => "http://localhost:11434"),
  getExtractModel: vi.fn(() => "llama3.2"),
}));

vi.mock("../shared/content.js", () => ({
  addFindingsToFile: vi.fn(() => ({
    ok: true,
    data: {
      added: ["[pattern] Retry socket setup after ECONNRESET"],
      skipped: [],
      rejected: [],
    },
  })),
}));

import { handleExtractMemories } from "../cli/extract.js";
import { runGit } from "../utils.js";
import { appendFindingJournal } from "../finding/journal.js";
import { appendReviewQueue } from "../shared/governance.js";
import { appendAuditLog } from "../shared.js";
import { register } from "../tools/extract.js";
import { addFindingsToFile } from "../shared/content.js";
import { generateText } from "../shared/ollama.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function gitLog(subject: string, body = "", hash = "abc12345"): string {
  return `${hash}\x1f${subject}\x1f${body}\x1e`;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

function makeMockServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    registerTool(name: string, _meta: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
    call(name: string, args: Record<string, unknown>) {
      const handler = tools.get(name);
      if (!handler) throw new Error(`Tool "${name}" not registered`);
      return handler(args);
    },
  };
}

function parseResult(res: { content: { type: string; text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

// ── CLI extract proactivity gating ──────────────────────────────────────────

describe("cli-extract proactivity gating", () => {
  beforeEach(() => {
    delete process.env.PHREN_PROACTIVITY;
    delete process.env.PHREN_PROACTIVITY_FINDINGS;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.PHREN_PROACTIVITY;
    delete process.env.PHREN_PROACTIVITY_FINDINGS;
  });

  it("keeps heuristic repo signal capture at high", async () => {
    process.env.PHREN_PROACTIVITY_FINDINGS = "high";
    vi.mocked(runGit).mockImplementation((_cwd, args) => {
      if (args[0] === "rev-parse") return "/repo";
      if (args[0] === "log") {
        return gitLog(
          "Socket reconnect workaround avoids duplicate token refresh",
          "Must avoid replaying the stale token after ECONNRESET"
        );
      }
      return "";
    });

    await handleExtractMemories("demo", "/repo", true, "sess-high");

    expect(appendFindingJournal).toHaveBeenCalledTimes(1);
    expect(appendReviewQueue).not.toHaveBeenCalled();
  });

  it('requires explicit repo signals at medium', async () => {
    process.env.PHREN_PROACTIVITY_FINDINGS = "medium";
    vi.mocked(runGit).mockImplementation((_cwd, args) => {
      if (args[0] === "rev-parse") return "/repo";
      if (args[0] === "log") {
        return gitLog(
          "Socket reconnect workaround avoids duplicate token refresh",
          "Must avoid replaying the stale token after ECONNRESET"
        );
      }
      return "";
    });

    await handleExtractMemories("demo", "/repo", true, "sess-medium-blocked");
    expect(appendFindingJournal).not.toHaveBeenCalled();
    expect(appendReviewQueue).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(runGit).mockImplementation((_cwd, args) => {
      if (args[0] === "rev-parse") return "/repo";
      if (args[0] === "log") {
        return gitLog(
          "Add finding about reconnect token reuse",
          "Worth remembering: retry once after ECONNRESET before refreshing the token"
        );
      }
      return "";
    });

    await handleExtractMemories("demo", "/repo", true, "sess-medium-allowed");
    expect(appendFindingJournal).toHaveBeenCalledTimes(1);
  });

  it("skips repo mining entirely at low", async () => {
    process.env.PHREN_PROACTIVITY_FINDINGS = "low";
    vi.mocked(runGit).mockImplementation((_cwd, args) => {
      if (args[0] === "rev-parse") return "/repo";
      if (args[0] === "log") {
        return gitLog(
          "Add finding about reconnect token reuse",
          "Worth remembering: retry once after ECONNRESET before refreshing the token"
        );
      }
      return "";
    });

    await handleExtractMemories("demo", "/repo", true, "sess-low");

    expect(appendFindingJournal).not.toHaveBeenCalled();
    expect(appendReviewQueue).not.toHaveBeenCalled();
    expect(appendAuditLog).toHaveBeenCalledWith("/tmpphren-proactivity-test", "extract_memories", "project=demo skipped=proactivity_low");
  });
});

// ── MCP extract proactivity gating ──────────────────────────────────────────

describe("mcp-extract proactivity gating", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmp = makeTempDir("mcp-extract-proactivity-");
    grantAdmin(tmp.path);
    fs.mkdirSync(path.join(tmp.path, "demo"), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, "demo", "summary.md"), "# demo\n");
    server = makeMockServer();

    const ctx: McpContext = {
      phrenPath: tmp.path,
      profile: "test",
      db: () => { throw new Error("db not expected"); },
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };

    register(server as any, ctx);
    delete process.env.PHREN_PROACTIVITY;
    delete process.env.PHREN_PROACTIVITY_FINDINGS;
    vi.mocked(addFindingsToFile).mockClear();
    vi.mocked(generateText).mockClear();
  });

  afterEach(() => {
    delete process.env.PHREN_PROACTIVITY;
    delete process.env.PHREN_PROACTIVITY_FINDINGS;
    tmp.cleanup();
  });

  it("persists auto-extracted findings at high", async () => {
    process.env.PHREN_PROACTIVITY_FINDINGS = "high";

    const res = parseResult(await server.call("auto_extract_findings", {
      project: "demo",
      text: "Race condition on reconnect can surface after ECONNRESET during warmup.",
    }));

    expect(res.ok).toBe(true);
    expect(addFindingsToFile).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit signal at medium before persisting findings', async () => {
    process.env.PHREN_PROACTIVITY_FINDINGS = "medium";

    const blocked = parseResult(await server.call("auto_extract_findings", {
      project: "demo",
      text: "Race condition on reconnect can surface after ECONNRESET during warmup.",
    }));
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('requires an explicit signal');
    expect(addFindingsToFile).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();

    const allowed = parseResult(await server.call("auto_extract_findings", {
      project: "demo",
      text: "This is worth remembering: retry the socket handshake once after ECONNRESET.",
    }));
    expect(allowed.ok).toBe(true);
    expect(addFindingsToFile).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("blocks auto-extracted finding persistence at low", async () => {
    process.env.PHREN_PROACTIVITY_FINDINGS = "low";

    const res = parseResult(await server.call("auto_extract_findings", {
      project: "demo",
      text: 'Add finding: retry the socket handshake once after ECONNRESET.',
    }));

    expect(res.ok).toBe(false);
    expect(res.error).toContain('disabled');
    expect(addFindingsToFile).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });
});
