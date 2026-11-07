// The dreaming changeset: the seam between the engine (collect/prompt/run/apply),
// the surfaces that start a dream and the evaluation harness. Shape fixed by the
// v1 contract; change it only in coordination with every consumer.

export type DreamFindingType = "decision" | "pitfall" | "pattern" | "bug";

export interface DreamEvidence {
  kind: "transcript" | "code" | "git" | "finding";
  /** session id+turn, path:line, sha, or fid */
  ref: string;
  quote?: string;
}

export type DreamChange =
  | { op: "add_finding"; text: string; findingType?: DreamFindingType; topic?: string; evidence: DreamEvidence[] }
  | { op: "supersede"; findingId: string; newText: string; evidence: DreamEvidence[] }
  | { op: "retract"; findingId: string; reason: string; evidence: DreamEvidence[] }
  | { op: "edit"; findingId: string; newText: string; evidence: DreamEvidence[] }
  | { op: "merge"; findingIds: string[]; newText: string; evidence: DreamEvidence[] }
  | { op: "move_topic"; findingId: string; topic: string }
  | { op: "promote_truth"; findingId: string; text: string; evidence: DreamEvidence[] }
  | { op: "demote_truth"; truth: string; reason: string }
  | { op: "write_page"; page: string /* reference/pages/<slug>.md */; markdown: string; links: string[] }
  | { op: "link"; findingId: string; entity: string };

export type DreamOp = DreamChange["op"];

export interface DreamChangeset {
  project: string;
  runId: string;
  startedAt: string;
  lookback: { from: string; to: string };
  inputs: { transcripts: number; findings: number; truths: number; pages: number };
  changes: DreamChange[];
  notes: string;
}
