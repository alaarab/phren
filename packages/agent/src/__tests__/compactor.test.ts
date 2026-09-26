import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { LlmMessage, LlmProvider, LlmResponse } from "../providers/types.js";
import {
  compactWithLlm,
  parseCheckpointResponse,
  routeKnowledgeItems,
  resolveCompactionConfig,
  DEFAULT_COMPACTION,
} from "../context/compactor.js";
import { planPrune } from "../context/pruner.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A long conversation: enough messages that planPrune has a range to cut. */
function longConversation(fillerChars = 3000): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: "user", content: "Original task: refactor the auth layer" }];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: "user", content: `step ${i}: ${"x".repeat(fillerChars)}` });
    messages.push({ role: "assistant", content: `did step ${i}` });
  }
  return messages;
}

function fakeProvider(responseText: string): LlmProvider & { calls: Array<{ system: string; messages: LlmMessage[]; toolCount: number }> } {
  const calls: Array<{ system: string; messages: LlmMessage[]; toolCount: number }> = [];
  return {
    name: "fake",
    calls,
    async chat(system, messages, tools): Promise<LlmResponse> {
      calls.push({ system, messages, toolCount: tools.length });
      return {
        content: [{ type: "text", text: responseText }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    },
  };
}

const GOOD_RESPONSE = `## Checkpoint Summary
The task was refactoring the auth layer. Work completed: extracted token validation into validators.ts, fixed the refresh race. Files modified: src/auth/validators.ts. Current approach: split validation from refresh. No unresolved errors. Next: wire the middleware.

## Knowledge
\`\`\`json
{"items":[
  {"text":"The token refresh endpoint must be called with the old refresh token, not the access token","confidence":0.9,"kind":"gotcha"},
  {"text":"Auth middleware ordering might matter for the rate limiter","confidence":0.6,"kind":"finding"},
  {"text":"Wild speculation about caching","confidence":0.3,"kind":"finding"}
]}
\`\`\``;

// ── parseCheckpointResponse ──────────────────────────────────────────────────

describe("parseCheckpointResponse", () => {
  it("parses summary and items from a well-formed response", () => {
    const { summary, items } = parseCheckpointResponse(GOOD_RESPONSE);
    expect(summary).toContain("refactoring the auth layer");
    expect(summary).not.toContain("## Checkpoint Summary");
    expect(items).toHaveLength(3);
    expect(items[0].confidence).toBe(0.9);
    expect(items[0].kind).toBe("gotcha");
  });

  it("keeps the summary when the JSON is botched", () => {
    const botched = GOOD_RESPONSE.replace('"confidence":0.9', '"confidence":oops');
    const { summary, items } = parseCheckpointResponse(botched);
    expect(summary).toContain("refactoring the auth layer");
    expect(items).toEqual([]);
  });

  it("salvages bare JSON without a fence", () => {
    const bare = `## Checkpoint Summary\n${"A".repeat(80)}\n\n## Knowledge\n{"items":[{"text":"bare item works","confidence":0.7,"kind":"finding"}]}`;
    const { summary, items } = parseCheckpointResponse(bare);
    expect(summary).not.toBeNull();
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("bare item works");
  });

  it("treats a response with no Knowledge heading as summary-only", () => {
    const text = `## Checkpoint Summary\n${"B".repeat(100)}`;
    const { summary, items } = parseCheckpointResponse(text);
    expect(summary).toBe("B".repeat(100));
    expect(items).toEqual([]);
  });

  it("returns null summary for empty or too-short responses", () => {
    expect(parseCheckpointResponse("").summary).toBeNull();
    expect(parseCheckpointResponse("## Checkpoint Summary\nshort").summary).toBeNull();
  });

  it("clamps out-of-range confidence and drops invalid items", () => {
    const text = `## Knowledge\n\`\`\`json\n{"items":[{"text":"over","confidence":5},{"text":"","confidence":0.9},{"confidence":0.9},{"text":"nan","confidence":"high"}]}\n\`\`\``;
    const { items } = parseCheckpointResponse(text);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ text: "over", confidence: 1 });
    expect(items[1]).toMatchObject({ text: "nan", confidence: 0 });
  });
});

// ── resolveCompactionConfig ──────────────────────────────────────────────────

describe("resolveCompactionConfig", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env.PHREN_AGENT_LLM_COMPACT = savedEnv.PHREN_AGENT_LLM_COMPACT;
    process.env.PHREN_AGENT_COMPACT_THRESHOLD = savedEnv.PHREN_AGENT_COMPACT_THRESHOLD;
    if (savedEnv.PHREN_AGENT_LLM_COMPACT === undefined) delete process.env.PHREN_AGENT_LLM_COMPACT;
    if (savedEnv.PHREN_AGENT_COMPACT_THRESHOLD === undefined) delete process.env.PHREN_AGENT_COMPACT_THRESHOLD;
  });

  it("defaults match the documented thresholds", () => {
    const cfg = resolveCompactionConfig();
    expect(cfg).toMatchObject({ enabled: true, promoteThreshold: 0.8, queueThreshold: 0.5 });
  });

  it("env kill switch disables", () => {
    process.env.PHREN_AGENT_LLM_COMPACT = "0";
    expect(resolveCompactionConfig().enabled).toBe(false);
  });

  it("explicit overrides win", () => {
    expect(resolveCompactionConfig({ promoteThreshold: 0.95 }).promoteThreshold).toBe(0.95);
  });
});

// ── compactWithLlm ───────────────────────────────────────────────────────────

describe("compactWithLlm", () => {
  it("returns null when there is nothing to prune", async () => {
    const provider = fakeProvider(GOOD_RESPONSE);
    const result = await compactWithLlm(provider, "system", [{ role: "user", content: "hi" }]);
    expect(result).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it("sends the byte-identical prefix plus one instruction, with no tools", async () => {
    const provider = fakeProvider(GOOD_RESPONSE);
    const messages = longConversation();
    const plan = planPrune(messages)!;

    const result = await compactWithLlm(provider, "the-system-prompt", messages);
    expect(result?.usedLlm).toBe(true);
    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0];
    expect(call.system).toBe("the-system-prompt");
    expect(call.toolCount).toBe(0);
    // Prefix replay: everything up to the end of the pruned range, unchanged.
    expect(call.messages.slice(0, plan.endIndex + 1)).toEqual(messages.slice(0, plan.endIndex + 1));
    const last = call.messages[call.messages.length - 1];
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("Context checkpoint");
  });

  it("produces an LLM summary message with identical prune indices", async () => {
    const provider = fakeProvider(GOOD_RESPONSE);
    const messages = longConversation();
    const regexPlan = planPrune(messages)!;

    const result = await compactWithLlm(provider, "sys", messages);
    expect(result?.plan.startIndex).toBe(regexPlan.startIndex);
    expect(result?.plan.endIndex).toBe(regexPlan.endIndex);
    expect(String(result?.plan.summaryMessage.content)).toContain("refactoring the auth layer");
    expect(result?.plan.summaryMessage.role).toBe("user");
  });

  it("falls back to the regex summary when the provider throws", async () => {
    const provider: LlmProvider = {
      name: "broken",
      async chat() { throw new Error("boom"); },
    };
    const messages = longConversation();
    const regexPlan = planPrune(messages)!;

    const result = await compactWithLlm(provider, "sys", messages);
    expect(result?.usedLlm).toBe(false);
    expect(result?.plan.summaryMessage).toEqual(regexPlan.summaryMessage);
  });

  it("falls back to the regex summary when the response summary is unusable", async () => {
    const provider = fakeProvider("nope");
    const messages = longConversation();
    const regexPlan = planPrune(messages)!;

    const result = await compactWithLlm(provider, "sys", messages);
    expect(result?.usedLlm).toBe(false);
    expect(result?.plan.summaryMessage).toEqual(regexPlan.summaryMessage);
  });

  it("skips the LLM entirely when the pruned range is tiny", async () => {
    const provider = fakeProvider(GOOD_RESPONSE);
    const messages = longConversation(20); // tiny messages — well under minPrunedTokens
    const result = await compactWithLlm(provider, "sys", messages);
    expect(result).not.toBeNull();
    expect(result?.usedLlm).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it("skips the LLM when disabled", async () => {
    const provider = fakeProvider(GOOD_RESPONSE);
    const result = await compactWithLlm(provider, "sys", longConversation(), {
      config: { enabled: false },
    });
    expect(result?.usedLlm).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it("records usage into the cost tracker", async () => {
    const provider = fakeProvider(GOOD_RESPONSE);
    const recordUsage = vi.fn();
    await compactWithLlm(provider, "sys", longConversation(), {
      costTracker: {
        totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0,
        recordUsage, isOverBudget: () => false, formatCost: () => "", formatTurnCost: () => "",
      } as never,
    });
    expect(recordUsage).toHaveBeenCalledWith(100, 50);
  });
});

// ── Knowledge routing (real store round-trip) ────────────────────────────────

describe("routeKnowledgeItems", () => {
  let storeDir: string;
  const project = "routetest";
  const savedPhrenPath = process.env.PHREN_PATH;

  beforeEach(() => {
    storeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-route-")));
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

  it("routes by confidence: ≥0.8 to findings, 0.5–0.8 to review queue, <0.5 dropped", async () => {
    const { promoted, queued } = await routeKnowledgeItems(
      [
        { text: "The build requires node 20 because of the sqljs wasm loader", confidence: 0.9, kind: "gotcha" },
        { text: "The retry helper may be duplicating backoff logic", confidence: 0.6, kind: "finding" },
        { text: "Total speculation about the cache", confidence: 0.2, kind: "finding" },
      ],
      {
        phrenCtx: { phrenPath: storeDir, profile: "", project },
        sessionId: "sess-route",
        config: DEFAULT_COMPACTION,
      },
    );

    expect(promoted).toBe(1);
    expect(queued).toBe(1);

    const findings = fs.readFileSync(path.join(storeDir, project, "FINDINGS.md"), "utf-8");
    expect(findings).toContain("node 20");
    expect(findings).toContain("session:sess-route");
    expect(findings).not.toContain("speculation");

    const review = fs.readFileSync(path.join(storeDir, project, "review.md"), "utf-8");
    expect(review).toContain("duplicating backoff");
    expect(review).toContain("<!-- source:agent session:sess-route -->");
    expect(review).not.toContain("speculation");
  });

  it("does nothing without a project", async () => {
    const result = await routeKnowledgeItems(
      [{ text: "anything", confidence: 0.95, kind: "finding" }],
      { phrenCtx: { phrenPath: storeDir, profile: "", project: null }, config: DEFAULT_COMPACTION },
    );
    expect(result).toEqual({ promoted: 0, queued: 0 });
  });

  it("caps routed items at maxItems", async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      text: `Distinct durable observation number ${i} about subsystem ${i}`,
      confidence: 0.9,
      kind: "finding",
    }));
    const { promoted } = await routeKnowledgeItems(items, {
      phrenCtx: { phrenPath: storeDir, profile: "", project },
      config: { ...DEFAULT_COMPACTION, maxItems: 3 },
    });
    expect(promoted).toBe(3);
  });
});
