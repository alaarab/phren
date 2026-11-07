/**
 * A scripted stand-in for the dreaming model. It answers each fixture
 * situation only when the prompt actually carries the evidence a real model
 * would need, so a passing eval shows that collect and the prompt surfaced
 * the right inputs, not just that the scorer matches a canned answer.
 */

import type { DreamChange } from "./contract-stub.js";
import type { HelperRunner } from "./contract-stub.js";
import { CLAUDE_SESSION, CODEX_SESSION, FACTS, FIDS, type EvalFixture } from "./fixture.js";
import { overBudget } from "../budget.js";

export interface ScriptedAnswer {
  changes: DreamChange[];
  /** Situations the prompt lacked the evidence for. */
  missing: string[];
}

export function scriptedChanges(prompt: string, fixture: EvalFixture): ScriptedAnswer {
  const changes: DreamChange[] = [];
  const missing: string[] = [];
  const has = (s: string) => prompt.includes(s);

  if (has(FIDS.contradicted) && has(FACTS.newPort)) {
    changes.push({
      op: "supersede", findingId: FIDS.contradicted,
      newText: "[pattern] The API dev server listens on port 4100 (src/server.ts); port 3000 belongs to the web app's own dev server.",
      evidence: [
        { kind: "transcript", ref: `claude:${CLAUDE_SESSION}#1`, quote: "Move the API dev server to port 4100" },
        { kind: "code", ref: "src/server.ts:1" },
      ],
    });
  } else missing.push("contradicted");

  if (has(FIDS.dupA) && has(FIDS.dupB)) {
    changes.push({
      op: "merge", findingIds: [FIDS.dupA, FIDS.dupB],
      newText: "[pitfall] Run `pnpm db:migrate` before `pnpm test`; without it the suite fails with \"relation does not exist\".",
      evidence: [{ kind: "finding", ref: FIDS.dupA }, { kind: "finding", ref: FIDS.dupB }],
    });
  } else missing.push("duplicates");

  if (FACTS.decisionPattern.test(prompt)) {
    changes.push({
      op: "add_finding", findingType: "decision",
      text: "The rate limiter uses Postgres advisory locks, not Redis, on-prem and cloud alike: Redis is unavailable in the customer's on-prem install and one code path beats two.",
      evidence: [{ kind: "transcript", ref: `codex:${CODEX_SESSION}#3`, quote: "drop Redis for the rate limiter and use Postgres advisory locks everywhere" }],
    });
  } else missing.push("decision");

  const inPrompt = fixture.staleTruths.filter((t) => has(t.slice(0, 60)));
  if (inPrompt.length) {
    const state = overBudget(fixture.store, fixture.project, fixture.budgetKB, { skipLookupLog: true });
    const stale = new Set(inPrompt);
    let freed = 0;
    for (const truth of state.ranking.filter((t) => stale.has(t.text))) {
      if (freed >= state.excessBytes) break;
      changes.push({ op: "demote_truth", truth: truth.text, reason: "Describes retired infrastructure; not cited in months and the injected layer is over budget." });
      freed += truth.bytes;
    }
  } else missing.push("budget");

  return { changes, missing };
}

/** The changeset JSON a model would print for this prompt. */
export function scriptedReply(prompt: string, fixture: EvalFixture): string {
  const { changes, missing } = scriptedChanges(prompt, fixture);
  return JSON.stringify({ changes, notes: missing.length ? `Not enough evidence for: ${missing.join(", ")}.` : "" });
}

/** A `runHelper`-shaped runner that answers with the scripted reply and records each prompt. */
export function scriptedRunner(fixture: EvalFixture, prompts: string[] = []): HelperRunner {
  return async (choice, options) => {
    prompts.push(options.prompt);
    return { ok: true, output: scriptedReply(options.prompt, fixture), project: choice.project, account: choice.account, model: "scripted", durationMs: 0 };
  };
}
