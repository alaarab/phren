import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PhrenContext } from "../memory/context.js";
import type { LlmProvider, LlmResponse } from "../providers/types.js";
import {
  getQueueStatus,
  listQueueItems,
  expireStaleItems,
  formatExpiryNotice,
  formatQueueBanner,
  formatQueueContextSection,
  proposeTriage,
  resolveExpireDays,
  DEFAULT_EXPIRE_DAYS,
} from "../memory/review-triage.js";
import { approveQueueItem } from "@phren/cli/data/access";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

describe("review-triage", () => {
  let storeDir: string;
  const project = "triagetest";
  const savedPhrenPath = process.env.PHREN_PATH;

  function ctx(): PhrenContext {
    return { phrenPath: storeDir, profile: "", project };
  }

  function writeQueue(lines: string[]): void {
    fs.writeFileSync(
      path.join(storeDir, project, "review.md"),
      `# Review\n\n## Review\n\n${lines.join("\n")}\n`,
    );
  }

  beforeEach(() => {
    storeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-triage-")));
    fs.writeFileSync(path.join(storeDir, "phren.root.yaml"), "version: 1\n");
    fs.mkdirSync(path.join(storeDir, project), { recursive: true });
    fs.writeFileSync(path.join(storeDir, project, "FINDINGS.md"), `# ${project} Findings\n`);
    process.env.PHREN_PATH = storeDir;
  });

  afterEach(() => {
    if (savedPhrenPath === undefined) delete process.env.PHREN_PATH;
    else process.env.PHREN_PATH = savedPhrenPath;
    delete process.env.PHREN_AGENT_QUEUE_EXPIRE_DAYS;
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it("reports empty status without a queue file and without a project", () => {
    expect(getQueueStatus(ctx())).toEqual({ pending: 0, top: [] });
    expect(getQueueStatus({ ...ctx(), project: null })).toEqual({ pending: 0, top: [] });
    expect(formatQueueBanner({ pending: 0, top: [] })).toBeNull();
    expect(formatQueueContextSection({ pending: 0, top: [] })).toBeNull();
  });

  it("counts pending items and formats the banner + context section", () => {
    writeQueue([
      `- [${isoDaysAgo(2)}] The cache layer might need a TTL`,
      `- [${isoDaysAgo(5)}] The retry helper may duplicate backoff logic`,
    ]);
    const status = getQueueStatus(ctx(), 3);
    expect(status.pending).toBe(2);
    expect(status.top[0].ageDays).toBe(2);

    const banner = formatQueueBanner(status)!;
    expect(banner).toContain("2 pending");
    expect(banner).toContain("/review");

    const section = formatQueueContextSection(status)!;
    expect(section).toContain("do NOT treat as truth");
    expect(section).toContain("[unverified] The cache layer might need a TTL");
  });

  it("expires only dated items older than the window", () => {
    writeQueue([
      `- [${isoDaysAgo(30)}] Ancient speculation about the parser`,
      `- [${isoDaysAgo(3)}] Fresh observation about the linter`,
      `- Undated entry that must never expire`,
    ]);
    const { expired } = expireStaleItems(ctx(), 14);
    expect(expired).toBe(1);

    const remaining = listQueueItems(ctx());
    expect(remaining.map((i) => i.text)).toEqual([
      "Fresh observation about the linter",
      "Undated entry that must never expire",
    ]);
  });

  it("expiry boundary: exactly at the window is kept", () => {
    writeQueue([`- [${isoDaysAgo(14)}] Exactly at the boundary`]);
    expect(expireStaleItems(ctx(), 14).expired).toBe(0);
    expect(listQueueItems(ctx())).toHaveLength(1);
  });

  it("expireDays 0 disables expiry", () => {
    writeQueue([`- [${isoDaysAgo(100)}] Very old`]);
    expect(expireStaleItems(ctx(), 0).expired).toBe(0);
  });

  it("never deletes a live finding when its queue line expires", () => {
    // Governance queues findings that already live in FINDINGS.md ("is this
    // still true?"). Expiry must drop the question, not the knowledge.
    const text = "Sessions must be closed before the pool is drained";
    fs.writeFileSync(
      path.join(storeDir, project, "FINDINGS.md"),
      `# ${project} Findings\n\n## Patterns\n\n- [pattern] ${text}\n`,
    );
    writeQueue([`- [${isoDaysAgo(40)}] ${text}`]);

    const result = expireStaleItems(ctx(), 14);
    expect(result.expired).toBe(1);
    expect(result.texts).toEqual([text]);

    expect(listQueueItems(ctx())).toHaveLength(0);
    const findings = fs.readFileSync(path.join(storeDir, project, "FINDINGS.md"), "utf-8");
    expect(findings).toContain(text);
  });

  it("expiry notice names what it dropped and says findings are untouched", () => {
    expect(formatExpiryNotice({ expired: 0, texts: [] })).toBeNull();

    const notice = formatExpiryNotice({ expired: 5, texts: ["alpha", "beta", "gamma", "delta", "epsilon"] })!;
    expect(notice).toContain("removed 5 stale items");
    expect(notice).toContain('"alpha"');
    expect(notice).toContain("+2 more");
    expect(notice).toContain("existing findings untouched");
  });

  it("resolveExpireDays honors the env override", () => {
    expect(resolveExpireDays()).toBe(DEFAULT_EXPIRE_DAYS);
    process.env.PHREN_AGENT_QUEUE_EXPIRE_DAYS = "30";
    expect(resolveExpireDays()).toBe(30);
    process.env.PHREN_AGENT_QUEUE_EXPIRE_DAYS = "0";
    expect(resolveExpireDays()).toBe(0);
  });

  it("queue lines round-trip exactly through approve", () => {
    writeQueue([`- [${isoDaysAgo(1)}] The build cache needs node 20 for the wasm loader`]);
    const items = listQueueItems(ctx());
    expect(items).toHaveLength(1);

    const result = approveQueueItem(storeDir, project, items[0].line);
    expect(result.ok).toBe(true);

    expect(listQueueItems(ctx())).toHaveLength(0);
    const findings = fs.readFileSync(path.join(storeDir, project, "FINDINGS.md"), "utf-8");
    expect(findings).toContain("wasm loader");
  });

  describe("proposeTriage", () => {
    function providerReturning(text: string): LlmProvider {
      return {
        name: "fake",
        async chat(): Promise<LlmResponse> {
          return { content: [{ type: "text", text }], stop_reason: "end_turn" };
        },
      };
    }

    const items = [
      { text: "Real durable gotcha", line: "- [2026-08-01] Real durable gotcha", date: "2026-08-01", ageDays: 10 },
      { text: "Vague speculation", line: "- [2026-08-02] Vague speculation", date: "2026-08-02", ageDays: 9 },
    ];

    it("parses fenced proposals and maps them back to lines", async () => {
      const proposals = await proposeTriage(
        providerReturning('```json\n{"proposals":[{"index":1,"verdict":"approve","reason":"specific"},{"index":2,"verdict":"reject","reason":"vague"}]}\n```'),
        items,
      );
      expect(proposals).toHaveLength(2);
      expect(proposals[0]).toMatchObject({ verdict: "approve", line: items[0].line });
      expect(proposals[1]).toMatchObject({ verdict: "reject", line: items[1].line });
    });

    it("drops invalid indices/verdicts and survives botched JSON", async () => {
      const bad = await proposeTriage(
        providerReturning('{"proposals":[{"index":99,"verdict":"approve"},{"index":1,"verdict":"maybe"},{"index":2,"verdict":"reject"}]}'),
        items,
      );
      expect(bad).toHaveLength(1);
      expect(bad[0].verdict).toBe("reject");

      expect(await proposeTriage(providerReturning("not json at all"), items)).toEqual([]);
    });

    it("returns [] when the provider throws", async () => {
      const broken: LlmProvider = { name: "broken", async chat() { throw new Error("down"); } };
      expect(await proposeTriage(broken, items)).toEqual([]);
    });
  });
});
