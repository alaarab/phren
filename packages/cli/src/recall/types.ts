// The prompt-time recall pipeline's contract: what goes in, what comes out.
// The UserPromptSubmit hook, the recall trace log and the recall eval all read this shape.

import type { SqlJsDatabase } from "../shared/index.js";
import type { SelectedSnippet } from "../shared/retrieval.js";
import type { GitContext } from "../cli/session-git.js";

/** Why the pipeline injected nothing. Null on the result when it selected something. */
export type RecallAbstainReason =
  | "machine-prompt" // another agent's message or a harness notice, not the owner asking
  | "no-keywords" // nothing left after stop words
  | "no-query" // no FTS query could be built from the keywords
  | "no-search-results" // search returned nothing
  | "trust-filtered" // the trust, notes and tasks filters dropped every row
  | "ranked-empty" // ranking dropped every row
  | "below-floor" // the relevance floor dropped every row
  | "nothing-selected" // selection produced no snippet
  | "all-repeats"; // every row selection reached showed a bullet this session already injected

/** Why the relevance floor kept or dropped one ranked row. */
export type RecallFloorReason =
  | "pass"
  | "changed-file" // kept: the doc is a file changed in the working tree
  | "floor-disabled" // kept: PHREN_MIN_QUERY_RELEVANCE=0
  | "too-few-keywords" // dropped: the prompt has fewer keywords than a chunk must match
  | "no-chunk" // dropped: no chunk matched any keyword
  | "too-few-matches" // dropped: best chunk matched fewer distinct keywords than required, not counting words in most docs
  | "low-rarity" // dropped: matched keywords' summed rarity under the bar
  | "no-anchor" // dropped: matched only two keywords and neither is rare
  | "low-overlap" // dropped: overlap under the (cross-project) floor
  | "below-best"; // dropped: matched under 60% of the strongest row's keyword rarity

export interface RecallDocRef {
  project: string;
  filename: string;
  type: string;
  path: string;
}

/** A row after ranking, before the floor, in rank order. */
export interface RecallCandidate extends RecallDocRef {
  score: number;
}

export interface RecallFloorDecision extends RecallDocRef {
  passed: boolean;
  reason: RecallFloorReason;
  /** Distinct prompt keywords the best chunk matched. */
  distinct: number;
  /** Summed rarity of those keywords (0..1 each). */
  rarity: number;
  /** Overlap score of the best chunk against the prompt keywords. */
  overlap: number;
  /** The prompt keywords the best chunk matched. */
  matched: string[];
}

export interface RecallSelected extends RecallDocRef {
  /** Score key (`entryScoreKey`), the `fb:` key the hook prints. */
  key: string;
  snippet: string;
}

export interface RecallStageMs {
  searchMs: number;
  trustMs: number;
  rankMs: number;
  selectMs: number;
}

export interface RecallPipelineInput {
  prompt: string;
  phrenPath: string;
  db: SqlJsDatabase;
  /** The project the prompt's cwd belongs to, or null (conductor, home folder). */
  detectedProject: string | null;
  cwd?: string;
  /** Null when the git module is off or cwd is no repository. */
  gitCtx?: GitContext | null;
  /** Keywords mentioned 3+ times this session; raises the token budget. Read-only here. */
  hotTopics?: string[];
  /** `bulletHash`es the hook injected this session within the repeat window; selection skips them. */
  recentlyInjected?: ReadonlySet<string>;
}

export interface RecallResult {
  /** Keywords extracted from the prompt, in extraction order. */
  keywords: string[];
  intent: "debug" | "review" | "build" | "docs" | "skill" | "general";
  detectedProject: string | null;
  abstained: RecallAbstainReason | null;
  /** Rows that survived the trust, notes and tasks filters (the hook's auto-extract runs when > 0). */
  trustSurvivors: number;
  candidates: RecallCandidate[];
  floor: RecallFloorDecision[];
  /** What selection chose, before the hook's once-per-session summary block and injection-budget trim. */
  selected: RecallSelected[];
  /** Internal: the selected rows with full documents, for the hook's output. Not part of the eval or trace. */
  selectedRows: SelectedSnippet[];
  /** Rows selection skipped because their bullet was in `recentlyInjected`. */
  suppressedRepeats: number;
  usedTokens: number;
  tokenBudget: number;
  stageMs: RecallStageMs;
}
