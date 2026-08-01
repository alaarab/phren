import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";

// Real store, real appendReviewQueue — only git is faked.
vi.mock("../utils.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../utils.js")>();
  return { ...orig, runGit: vi.fn() };
});

vi.mock("../hooks.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../hooks.js")>();
  return { ...orig, commandExists: vi.fn(() => false) };
});

const PROJECT = "demo";

interface GitCommit {
  hash: string;
  subject: string;
  body?: string;
}

function gitLog(commits: GitCommit[]): string {
  return commits.map((c) => `${c.hash}\x1f${c.subject}\x1f${c.body ?? ""}\x1e`).join("");
}

/** A commit that scores as a candidate but stays under the auto-accept threshold. */
const RECONNECT: GitCommit = {
  hash: "0a918619ffb14a3d1d0b2f0d3f3f0a1b2c3d4e5f",
  subject: "Socket reconnect workaround avoids duplicate token refresh",
  body: "Must avoid replaying the stale token after a dropped connection",
};
const DEADLOCK: GitCommit = {
  hash: "6b9a2ab9aa11bb22cc33dd44ee55ff6600112233",
  subject: "Connection pool race condition causes an intermittent deadlock",
  body: "Root cause: the pool must avoid handing out a checked-out handle twice",
};

let tmp: { path: string; cleanup: () => void };

/**
 * cli/extract.ts resolves the phren root lazily and caches it, so PHREN_PATH has to be set
 * before the module graph is (re)loaded. Import the mocked modules from the same fresh
 * registry so the runGit stub is the one extract.ts actually calls.
 */
async function loadExtract(commits: GitCommit[]) {
  process.env.PHREN_PATH = tmp.path;
  vi.resetModules();
  const utils = await import("../utils.js");
  vi.mocked(utils.runGit).mockImplementation((_cwd: string, args: string[]) => {
    if (args[0] === "rev-parse") return "/repo";
    if (args[0] === "log") return gitLog(commits);
    return "";
  });
  return await import("../cli/extract.js");
}

function reviewQueueEntries(): string[] {
  const queuePath = path.join(tmp.path, PROJECT, "review.md");
  if (!fs.existsSync(queuePath)) return [];
  return fs.readFileSync(queuePath, "utf8").split("\n").filter((l) => l.startsWith("- "));
}

beforeEach(() => {
  tmp = makeTempDir("phren-extract-idempotency-");
  grantAdmin(tmp.path);
  writeFile(path.join(tmp.path, PROJECT, "summary.md"), `# ${PROJECT}\n`);
  // Force every candidate into the review queue rather than straight into findings.
  process.env.PHREN_MEMORY_AUTO_ACCEPT = "0.99";
  process.env.PHREN_PROACTIVITY_FINDINGS = "high";
});

afterEach(() => {
  delete process.env.PHREN_PATH;
  delete process.env.PHREN_MEMORY_AUTO_ACCEPT;
  delete process.env.PHREN_PROACTIVITY_FINDINGS;
  tmp.cleanup();
});

describe("extractSubjectKey", () => {
  it("collapses the rendered decoration two runs disagree on", async () => {
    const { extractSubjectKey } = await loadExtract([]);
    const fromQueue = extractSubjectKey("[confidence 0.65] Socket reconnect workaround (source commit 0a918619)");
    const fromFindings = extractSubjectKey("Socket reconnect workaround (source commit c55f38fa) <!-- created: 2026-05-18 -->");
    expect(fromQueue).toBe("socket reconnect workaround");
    expect(fromFindings).toBe(fromQueue);
  });
});

describe("extract idempotency", () => {
  it("running extract twice over the same commits produces no duplicate queue entries", async () => {
    const { handleExtractMemories } = await loadExtract([RECONNECT, DEADLOCK]);

    await handleExtractMemories(PROJECT, "/repo", true);
    const afterFirst = reviewQueueEntries();
    expect(afterFirst).toHaveLength(2);

    await handleExtractMemories(PROJECT, "/repo", true);
    const afterSecond = reviewQueueEntries();
    expect(afterSecond).toEqual(afterFirst);

    // Recognised as already-processed rather than merely deduped on rendered text.
    const audit = fs.readFileSync(path.join(tmp.path, ".runtime", "audit.log"), "utf8");
    expect(audit.trim().split("\n").pop()).toContain("queued=0 duplicates=2");
  });

  it("re-queues nothing when the queued line drifted from what extraction renders", async () => {
    const { handleExtractMemories } = await loadExtract([RECONNECT]);
    await handleExtractMemories(PROJECT, "/repo", true);

    // appendReviewQueue dedups on the whole rendered line, so any drift (confidence,
    // wording) let the same commit back in on every sync run. The source-commit marker
    // has to be the dedup key instead.
    const queuePath = path.join(tmp.path, PROJECT, "review.md");
    fs.writeFileSync(
      queuePath,
      fs.readFileSync(queuePath, "utf8").replace(/\[confidence [\d.]+\]/, "[confidence 0.42]"),
    );

    await handleExtractMemories(PROJECT, "/repo", true);
    expect(reviewQueueEntries()).toHaveLength(1);
  });

  it("stays stable across many runs, the way nightly sync calls it", async () => {
    const { handleExtractMemories } = await loadExtract([RECONNECT, DEADLOCK]);
    for (let run = 0; run < 8; run++) {
      await handleExtractMemories(PROJECT, "/repo", true);
    }
    expect(reviewQueueEntries()).toHaveLength(2);
  });

  it("does not re-queue a commit that was already promoted into FINDINGS.md", async () => {
    writeFile(
      path.join(tmp.path, PROJECT, "FINDINGS.md"),
      `# ${PROJECT} Findings\n\n## 2026-05-18\n\n- Socket reconnect workaround avoids duplicate token refresh (source commit ${RECONNECT.hash.slice(0, 8)})\n`,
    );
    const { handleExtractMemories } = await loadExtract([RECONNECT, DEADLOCK]);

    await handleExtractMemories(PROJECT, "/repo", true);
    const entries = reviewQueueEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("deadlock");
  });

  it("does not re-queue an identical subject that rebasing gave a new hash", async () => {
    const { handleExtractMemories } = await loadExtract([RECONNECT]);
    await handleExtractMemories(PROJECT, "/repo", true);
    expect(reviewQueueEntries()).toHaveLength(1);

    // Same commit message, rewritten hash — observed in the real store as the
    // 0a918619/c55f38fa and 6b9a2ab9/9479d2ad pairs.
    const rebased = await loadExtract([{ ...RECONNECT, hash: "c55f38fa9988776655443322110099887766aabb" }]);
    await rebased.handleExtractMemories(PROJECT, "/repo", true);
    expect(reviewQueueEntries()).toHaveLength(1);
  });

  it("does not resurrect an entry a human removed from review.md", async () => {
    const { handleExtractMemories } = await loadExtract([RECONNECT, DEADLOCK]);
    await handleExtractMemories(PROJECT, "/repo", true);

    const queuePath = path.join(tmp.path, PROJECT, "review.md");
    const kept = fs.readFileSync(queuePath, "utf8")
      .split("\n")
      .filter((line) => !line.includes("Socket reconnect"))
      .join("\n");
    fs.writeFileSync(queuePath, kept);
    expect(reviewQueueEntries()).toHaveLength(1);

    await handleExtractMemories(PROJECT, "/repo", true);
    expect(reviewQueueEntries()).toHaveLength(1);
  });

  it("still queues a genuinely new commit", async () => {
    const { handleExtractMemories } = await loadExtract([RECONNECT]);
    await handleExtractMemories(PROJECT, "/repo", true);
    expect(reviewQueueEntries()).toHaveLength(1);

    const next = await loadExtract([RECONNECT, DEADLOCK]);
    await next.handleExtractMemories(PROJECT, "/repo", true);
    expect(reviewQueueEntries()).toHaveLength(2);
  });

  it("never queues garbage captured from a commit subject", async () => {
    const { handleExtractMemories } = await loadExtract([
      {
        hash: "deadbeef00112233445566778899aabbccddeeff",
        // Long enough to score, but it is a transient environment failure.
        subject: "Workaround: command 'pnpm build' failed: EACCES permission denied on dist",
      },
    ]);
    await handleExtractMemories(PROJECT, "/repo", true);
    expect(reviewQueueEntries()).toEqual([]);
  });
});
