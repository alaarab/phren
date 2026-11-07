// The dreaming prompt. It tells the model what this memory is for and what makes it
// useful, then hands it the evidence and the current memory, and asks for a changeset.
// Purpose-led on purpose: procedural rules ("record only failures") make worse memory.
import { sanitizeDream } from "./privacy.js";
import { scanForSecrets } from "../content/secrets.js";
import type { DreamInputs } from "./collect.js";
import type { DreamOp } from "./types.js";

export const DREAM_PHASES = ["capture", "correct", "organize", "prune"] as const;
export type DreamPhase = typeof DREAM_PHASES[number];

/** Which operations each phase allows. An op is allowed when any enabled phase lists it. */
export const PHASE_OPS: Record<DreamPhase, DreamOp[]> = {
  capture: ["add_finding"],
  correct: ["supersede", "retract", "edit"],
  organize: ["merge", "move_topic", "write_page", "link", "promote_truth"],
  prune: ["retract", "merge", "demote_truth"],
};

const PHASE_PURPOSE: Record<DreamPhase, string> = {
  capture: "Capture: knowledge the sessions produced that a future session would otherwise have to rediscover (decisions and their reasons, pitfalls, working fixes, conventions the owner stated) and that is not already saved.",
  correct: "Correct: saved findings that the sessions, the code or the git history now contradict or make outdated. Supersede when there is a newer truth, edit when the wording is wrong but the point stands, retract when it was simply wrong.",
  organize: "Organize: one subject per page, duplicates merged, findings filed under the right topic, fragments linked, and the few facts every session truly needs promoted to truths.",
  prune: "Prune: what no longer earns its place. Retract the obsolete, merge the repetitive, and demote truths when the always-injected layer is over its budget.",
};

export const CHANGESET_SCHEMA = `{
  "changes": DreamChange[],   // at most MAX_CHANGES; fewer is better than padding
  "notes": string             // one or two sentences: what you noticed, what you left alone and why
}
DreamEvidence = { "kind": "transcript"|"code"|"git"|"finding", "ref": string, "quote"?: string }
  // ref: transcript → "<session>#t<turn>" exactly as shown; code → "path:line"; git → short sha; finding → fid
DreamChange =
  | { "op": "add_finding", "text": string, "findingType"?: "decision"|"pitfall"|"pattern"|"bug", "topic"?: string, "evidence": DreamEvidence[] }
  | { "op": "supersede", "findingId": string, "newText": string, "evidence": DreamEvidence[] }
  | { "op": "retract", "findingId": string, "reason": string, "evidence": DreamEvidence[] }
  | { "op": "edit", "findingId": string, "newText": string, "evidence": DreamEvidence[] }
  | { "op": "merge", "findingIds": string[], "newText": string, "evidence": DreamEvidence[] }
  | { "op": "move_topic", "findingId": string, "topic": string }
  | { "op": "promote_truth", "findingId": string, "text": string, "evidence": DreamEvidence[] }
  | { "op": "demote_truth", "truth": string, "reason": string }
  | { "op": "write_page", "page": "reference/pages/<slug>.md", "markdown": string, "links": string[] }
  | { "op": "link", "findingId": string, "entity": string }
findingId / findingIds are fids from the findings list (8 hex characters). demote_truth.truth is the truth's text as listed.
write_page markdown starts with frontmatter (title, summary), then the body; cite findings as fid:xxxxxxxx and other pages as [[slug]]; links lists those slugs.`;

export interface DreamPromptOptions {
  phases: DreamPhase[];
  maxChanges: number;
  now: Date;
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim() || "(none)"}\n`;
}

export function buildDreamPrompt(inputs: DreamInputs, options: DreamPromptOptions): string {
  inputs = sanitizeDream(inputs);
  const phases = options.phases.length ? options.phases : [...DREAM_PHASES];
  const allowed = [...new Set(phases.flatMap(phase => PHASE_OPS[phase]))];
  const budget = inputs.budget;
  const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
  const budgetLine = budget.over
    ? `The always-injected layer is ${kb(budget.sizeBytes)}, over its ${kb(budget.budgetBytes)} budget. Demote until it fits; least recently cited first: ${budget.candidates.slice(0, 10).map(c => JSON.stringify(c)).join("; ") || "(no candidates listed)"}.`
    : `The always-injected layer is ${kb(budget.sizeBytes)} of its ${kb(budget.budgetBytes)} budget. A promotion that would push it over needs a matching demotion in the same changeset.`;

  const transcripts = inputs.transcripts.map(t =>
    `### ${t.source} session ${t.session} (${t.cwd}, ${t.first} → ${t.last}${t.trimmed ? ", oldest turns trimmed" : ""})\n${t.text}`).join("\n\n");
  const findings = inputs.findings.map(f =>
    `- fid:${f.fid} [${f.date}${f.status !== "active" ? `, ${f.status}` : ""}] ${f.text}${f.citation ? ` (cites ${f.citation})` : ""}`).join("\n");

  const prompt = [
    `You are dreaming for the Phren project "${inputs.project}": an offline pass between sessions that reorganizes the project's memory. It is ${options.now.toISOString()}.`,
    "",
    section("What this memory is for", `
Coding agents start every session knowing nothing. This memory is what lets the next session start where the last one ended: why things are the way they are, what was tried and failed, what the owner decided, what will bite you. It is read by agents, so it should be true, specific and short.

What good memory looks like:
- It records what the environment can't show. Code, file listings, git history and current screen state can be read fresh at any time and go stale when copied; the reasons behind them, decisions, dead ends and the owner's preferences cannot.
- It is true. A wrong note does more harm than a missing one, because agents trust it. The transcripts below are what actually happened; where they, the code or git contradict a saved finding, the transcript is the better witness, and the finding should be corrected.
- The always-injected layer (truths) is small. Everything in it reaches every session, including its errors, so it holds only what nearly every session needs.
- One page per subject beats a long shared file. Related findings belong together under a topic or on a page that links to the others.
- It does not bloat. Merging two notes into one better note is progress; restating what is already saved is not.

Be selective. Changing nothing is a fine outcome when the memory is already right. Every change that asserts something must cite evidence from the material below: the session and turn, a path:line you read, a commit, or an existing fid. You may read files in the working directory to check a claim against the code; do not edit anything.`),
    section("This pass", `
${phases.map(phase => `- ${PHASE_PURPOSE[phase]}`).join("\n")}

Allowed operations: ${allowed.join(", ")}. At most ${options.maxChanges} changes.
${budgetLine}`),
    section("Earlier dreams (journal)", inputs.journal.join("\n")),
    section(`Sessions ${inputs.from} → ${inputs.to}`, `${transcripts}${inputs.transcriptsDropped ? `\n\n(${inputs.transcriptsDropped} older sessions left out for length)` : ""}`),
    section("Saved findings", findings),
    section("Truths (always injected)", inputs.truths.map(t => `- ${t}`).join("\n")),
    section("Topics", inputs.topics.map(t => `- ${t.slug}: ${t.label}`).join("\n")),
    section("Pages", inputs.pages.map(p => `- ${p.slug}: ${p.title}${p.summary ? ` — ${p.summary}` : ""}`).join("\n")),
    section(`Recent commits${inputs.repoDir ? ` (${inputs.repoDir})` : ""}`, inputs.gitLog.join("\n")),
    section("Answer", `Reply with one JSON object and nothing else (no prose, no code fence), in this shape:\n\n${CHANGESET_SCHEMA.replace("MAX_CHANGES", String(options.maxChanges))}`),
  ].join("\n");
  if (scanForSecrets(prompt)) throw new Error("Dream prompt withheld: secret detected.");
  return prompt;
}
