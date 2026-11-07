// CONTRACT STUB — worker B owns this file. The orchestrator replaces it with B's version at integration.
// Copied verbatim from the v1 contract (section 2) so worker A's surfaces compile.

export interface DreamEvidence { kind: "transcript" | "code" | "git" | "finding"; ref: string; quote?: string }

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

export interface DreamChangeset {
  project: string; runId: string; startedAt: string; lookback: { from: string; to: string };
  inputs: { transcripts: number; findings: number; truths: number; pages: number }; changes: DreamChange[]; notes: string;
}
