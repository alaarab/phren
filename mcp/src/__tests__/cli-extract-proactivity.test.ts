import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    getCortexPath: () => "/tmp/cortex-proactivity-test",
  };
});

vi.mock("../shared-governance.js", () => ({
  appendReviewQueue: vi.fn(() => ({ ok: true, data: 1 })),
  getRetentionPolicy: vi.fn(() => ({ autoAcceptThreshold: 0.5 })),
  recordFeedback: vi.fn(),
  flushEntryScores: vi.fn(),
  entryScoreKey: vi.fn(() => "score-key"),
}));

vi.mock("../finding-journal.js", () => ({
  appendFindingJournal: vi.fn(() => ({ ok: true, data: "journal" })),
  compactFindingJournals: vi.fn(() => ({ added: 0, skipped: 0, failed: 0 })),
}));

vi.mock("../hooks.js", () => ({
  commandExists: vi.fn(() => false),
}));

import { handleExtractMemories } from "../cli-extract.js";
import { runGit } from "../utils.js";
import { appendFindingJournal } from "../finding-journal.js";
import { appendReviewQueue } from "../shared-governance.js";
import { appendAuditLog } from "../shared.js";

function gitLog(subject: string, body = "", hash = "abc12345"): string {
  return `${hash}\x1f${subject}\x1f${body}\x1e`;
}

describe("cli-extract proactivity gating", () => {
  beforeEach(() => {
    delete process.env.CORTEX_PROACTIVITY;
    delete process.env.CORTEX_PROACTIVITY_FINDINGS;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CORTEX_PROACTIVITY;
    delete process.env.CORTEX_PROACTIVITY_FINDINGS;
  });

  it("keeps heuristic repo signal capture at high", async () => {
    process.env.CORTEX_PROACTIVITY_FINDINGS = "high";
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
    process.env.CORTEX_PROACTIVITY_FINDINGS = "medium";
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
    process.env.CORTEX_PROACTIVITY_FINDINGS = "low";
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
    expect(appendAuditLog).toHaveBeenCalledWith("/tmp/cortex-proactivity-test", "extract_memories", "project=demo skipped=proactivity_low");
  });
});
