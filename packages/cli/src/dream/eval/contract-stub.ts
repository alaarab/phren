// CONTRACT STUB — worker C. Remove at integration.
//
// Worker B owns `dream/types.ts` and `dream/run.ts`; they are not on this
// branch. These copies of the contract (section 2) let the eval harness
// compile. At integration:
//  - replace the type exports below with `export type { ... } from "../types.js"`,
//  - make `defaultDream` call B's `dream` from "../run.js", passing the helper
//    runner through whatever option B named for its injected runner.

export type DreamChange =
  | { op: "add_finding"; text: string; findingType?: "decision" | "pitfall" | "pattern" | "bug"; topic?: string; evidence: DreamEvidence[] }
  | { op: "supersede"; findingId: string; newText: string; evidence: DreamEvidence[] }
  | { op: "retract"; findingId: string; reason: string; evidence: DreamEvidence[] }
  | { op: "edit"; findingId: string; newText: string; evidence: DreamEvidence[] }
  | { op: "merge"; findingIds: string[]; newText: string; evidence: DreamEvidence[] }
  | { op: "move_topic"; findingId: string; topic: string }
  | { op: "promote_truth"; findingId: string; text: string; evidence: DreamEvidence[] }
  | { op: "demote_truth"; truth: string; reason: string }
  | { op: "write_page"; page: string; markdown: string; links: string[] }
  | { op: "link"; findingId: string; entity: string };

export interface DreamEvidence { kind: "transcript" | "code" | "git" | "finding"; ref: string; quote?: string }

export interface DreamChangeset {
  project: string; runId: string; startedAt: string; lookback: { from: string; to: string };
  inputs: { transcripts: number; findings: number; truths: number; pages: number }; changes: DreamChange[]; notes: string;
}

/** A `runHelper`-shaped runner (bridge/helper.ts): what B injects in place of `claude -p`. */
export type HelperRunner = typeof import("../../bridge/helper.js").runHelper;

export interface EvalDreamOptions {
  dryRun?: boolean;
  mode?: "propose" | "apply";
  now?: Date;
  force?: boolean;
  /** Omitted for a real-model run: B's dream then uses the project's helper. */
  runner?: HelperRunner;
}

export type DreamFn = (project: string, opts: EvalDreamOptions) => Promise<unknown>;

export const defaultDream: DreamFn = async () => {
  throw new Error("dream eval: dream/run.ts is not integrated on this branch (CONTRACT STUB).");
};
