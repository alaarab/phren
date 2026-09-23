#!/usr/bin/env node
/**
 * Generates ground-truth fixtures for PhrenKit's parser/serializer tests by
 * running the REAL CLI functions against a temp store and snapshotting the
 * resulting files. Regenerate after CLI format changes:
 *
 *   pnpm --filter @phren/cli build
 *   node apps/ios/scripts/generate-fixtures.mjs
 *
 * A PhrenKit test failure after regeneration flags a format change that the
 * Swift transcriptions must absorb.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const dist = path.join(repoRoot, "packages/cli/dist");
const fixturesDir = path.resolve(here, "../PhrenKit/Tests/PhrenKitTests/Fixtures");

// --- Determinism helpers ----------------------------------------------------
//
// `content/learning.ts` (owned by this script's author) takes an explicit
// `now`/`idSource` override on `addFindingToFile`, so findings calls below
// just pass fixed values directly — see docs/store-format.md §7.
//
// `data/tasks.ts`, `data/notes.ts`, and `governance/policy.ts` are not this
// script's to change, and none of them accept an injected clock or id source
// for the id/date this file bakes in (task `bid`, note `nid`, and the queue
// entry's `[YYYY-MM-DD]` prefix respectively) — every one of them calls
// `crypto.randomBytes(4)` or `new Date()` directly. Determinism for those
// three is produced here instead, by patching the process-wide primitive
// each one reads from — the same trick the pre-existing `globalThis.Date`
// freeze further down already uses for the team journal, generalized to a
// `crypto.randomBytes` version.
//
// `import { randomBytes } from "crypto"` inside the CLI's compiled dist is a
// *named* ESM import. Two things about that are easy to get wrong here,
// both confirmed empirically against this exact Node version before relying
// on them:
//
// 1. A namespace import of a real ESM module is read-only (`import * as
//    crypto from "crypto"; crypto.randomBytes = fn` throws `Cannot assign to
//    read only property`) — but Node's builtins are CommonJS underneath, and
//    `createRequire` reaches the mutable `module.exports` object every
//    `require("crypto")`/named-ESM-import call resolves against.
// 2. That binding is resolved once, at each *importing* module's first
//    evaluation — not a live getter re-read on every call. A module that
//    imported `randomBytes` before this patch is installed keeps using the
//    original function forever after, no matter how many times the crypto
//    module's property is reassigned post-hoc. Since every dist module below
//    is imported once, at the top of this script, the patch MUST be installed
//    before those `await import(...)` calls, as one persistent function
//    reference — reconfigured via the queue below, never by reassignment —
//    or it silently has no effect on `data/tasks.js` and `data/notes.js`.
const cryptoCjs = createRequire(import.meta.url)("crypto");
const realRandomBytes = cryptoCjs.randomBytes;
const fixedIdQueue = [];
cryptoCjs.randomBytes = (size) => {
  if (fixedIdQueue.length === 0) return realRandomBytes(size);
  const hex = fixedIdQueue.shift();
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== size) throw new Error(`fixed id "${hex}" is ${buf.length} bytes, expected ${size}`);
  return buf;
};

/**
 * Run `fn` with the next `crypto.randomBytes` call(s) returning `hexIds` in
 * order (falling back to real randomness once the queue empties — e.g. the
 * internal `addFindingToFile` call inside `approveQueueItem` below, whose
 * output is never snapshotted). Throws if `fn` leaves ids unconsumed — a
 * silent miscount would mean a fixture went back to being nondeterministic
 * without anyone noticing.
 */
function withFixedIds(hexIds, fn) {
  fixedIdQueue.push(...hexIds);
  const result = fn();
  if (fixedIdQueue.length > 0) {
    const leftover = fixedIdQueue.splice(0);
    throw new Error(`withFixedIds: ${leftover.length} fixed id(s) went unused: ${leftover.join(", ")}`);
  }
  return result;
}

const access = await import(path.join(dist, "data/access.js"));
const notes = await import(path.join(dist, "data/notes.js"));
const tasks = await import(path.join(dist, "data/tasks.js"));
const learning = await import(path.join(dist, "content/learning.js"));
const policy = await import(path.join(dist, "governance/policy.js"));
const journal = await import(path.join(dist, "finding/journal.js"));
const skillState = await import(path.join(dist, "skill/state.js"));
const { entryScoreKey } = await import(path.join(dist, "governance/scores.js"));
const { findingStableId } = await import(path.join(dist, "finding-graph-id.js"));

/** Run `fn` with `new Date()` frozen to a fixed instant (bare `new Date()`
 *  only — same shape as the pre-existing per-call freeze further down).
 *  Unlike `randomBytes` above, `Date` is a global, not a module import — a
 *  bare `new Date()` re-resolves `Date` against `globalThis` on every call,
 *  so reassigning it here is unconditionally visible everywhere, regardless
 *  of import order. */
function withFrozenDate(iso, fn) {
  const RealDate = Date;
  globalThis.Date = class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : [iso]));
    }
  };
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

const store = fs.mkdtempSync(path.join(os.tmpdir(), "phren-fixtures-"));
const project = "myproj";
fs.mkdirSync(path.join(store, project), { recursive: true });
// A root manifest so path helpers treat this directory as a store root.
fs.writeFileSync(path.join(store, "phren.root.yaml"), "installMode: shared\nsyncMode: workspace-git\n");

// Wipe every fixture this script owns so stale/renamed files don't linger —
// but `swift-writes/` is the *other* direction's committed corpus
// (SwiftWritesFixturesTests.swift, Task 2 bidirectional conformance): it is
// regenerated only by `PHREN_REGENERATE_SWIFT_FIXTURES=1 swift test`, never
// by this script, so it must survive the wipe untouched. The hand-authored
// Hook protocol corpus is shared by Swift and TypeScript and must survive too.
// The Copilot backlog frame is written by the Hook's transcript-copilot.test.ts
// (PHREN_UPDATE_FIXTURES=1) from its sanitized real session.
const PRESERVE_ON_WIPE = new Set(["swift-writes", "hook-events.json", "copilot-1.0.87-backlog.json"]);
fs.mkdirSync(fixturesDir, { recursive: true });
for (const entry of fs.readdirSync(fixturesDir)) {
  if (PRESERVE_ON_WIPE.has(entry)) continue;
  fs.rmSync(path.join(fixturesDir, entry), { recursive: true, force: true });
}

function must(result, label) {
  if (result && result.ok === false) {
    throw new Error(`${label} failed: ${result.message}`);
  }
  return result;
}

function snapshot(name, relPath) {
  const src = path.join(store, relPath);
  const dest = path.join(fixturesDir, name);
  fs.copyFileSync(src, dest);
  console.log(`wrote ${name}`);
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(fixturesDir, name), JSON.stringify(value, null, 2) + "\n");
  console.log(`wrote ${name}`);
}

// --- FINDINGS.md ------------------------------------------------------------

// Fixed now/idSource per call (content/learning.ts's injection seam — see
// docs/store-format.md §7) so `fid` and the created/citation timestamps are
// reproducible across regenerations instead of a fresh CSPRNG id and
// wall-clock time every run.
must(learning.addFindingToFile(store, project, "[pattern] Always validate JWT expiry before refresh", undefined, {
  provenance: { source: "human", machine: "test-machine", actor: "tester", tool: "phren-ios" },
  now: new Date("2026-07-26T18:28:11.853Z"),
  idSource: () => "6957f9f8",
}), "add finding 1");
must(learning.addFindingToFile(store, project, "[decision] Chose SQLite FTS5 over embeddings for v1 search", undefined, {
  scope: "builder",
  now: new Date("2026-07-26T18:28:11.859Z"),
  idSource: () => "a505fe4e",
}), "add finding 2");
must(learning.addFindingToFile(store, project, "Plain finding with no tag and no options", undefined, {
  now: new Date("2026-07-26T18:28:11.862Z"),
  idSource: () => "38209d83",
}), "add finding 3");
snapshot("findings-after-add.md", `${project}/FINDINGS.md`);

must(access.editFinding(store, project, "Plain finding with no tag", "Edited finding text that replaced the plain one"), "edit finding");
snapshot("findings-after-edit.md", `${project}/FINDINGS.md`);

must(access.removeFinding(store, project, "Chose SQLite FTS5 over embeddings"), "remove finding");
snapshot("findings-after-remove.md", `${project}/FINDINGS.md`);

const parsedFindings = must(access.readFindings(store, project), "read findings");
writeJson("findings-parsed.json", parsedFindings.data);

// --- team store journal -----------------------------------------------------

// A store with `role: team` never line-splices FINDINGS.md on an add — the
// finding goes to an append-only `journal/YYYY-MM-DD-<actor>.md` instead
// (tools/finding.ts:186 → finding/journal.ts:150). `appendTeamJournal` stamps
// `new Date()` itself and takes no date argument, so the clock is frozen
// around these calls to keep the fixture stable across regenerations.
const journalDate = "2026-07-28";
const RealDate = Date;
globalThis.Date = class FrozenDate extends RealDate {
  constructor(...args) {
    super(...(args.length > 0 ? args : [`${journalDate}T09:15:00.000Z`]));
  }
};
must(journal.appendTeamJournal(store, project,
  "[decision] Team stores journal their findings instead of splicing FINDINGS.md",
  "tester", "test-machine"), "journal entry 1");
must(journal.appendTeamJournal(store, project,
  "Second entry of the day appends to the same actor file",
  "tester", "test-machine"), "journal entry 2");
// A second actor on the same day gets its own file — that is the whole point
// of the layout, and it is what makes concurrent writers merge cleanly.
// No machine here, so buildSourceComment drops the machine token entirely.
must(journal.appendTeamJournal(store, project,
  "Entry written by a different actor on the same day",
  "other-actor", undefined), "journal entry 3");
globalThis.Date = RealDate;

snapshot(`journal-${journalDate}-tester.md`, `${project}/journal/${journalDate}-tester.md`);
snapshot(`journal-${journalDate}-other-actor.md`, `${project}/journal/${journalDate}-other-actor.md`);
writeJson("journal-parsed.json", journal.readTeamJournalEntries(store, project));

// --- review.md --------------------------------------------------------------

// `appendReviewQueue` (governance/policy.ts) stamps its `[YYYY-MM-DD]` date
// prefix from a bare `new Date()` with no override parameter, and that file
// isn't this script's to change — so the clock is frozen the same way as the
// team journal above, just via the shared helper.
withFrozenDate("2026-07-26T12:00:00.000Z", () => {
  must(policy.appendReviewQueue(store, project, "Review", [
    "- [pitfall] Session hooks fire twice when both MCP and hooks mode are enabled [confidence 0.85] <!-- source:agent machine:test-machine model:test-model -->",
    "- Low-confidence auto capture that should look risky [confidence 0.4]",
  ]), "append review queue");
  must(policy.appendReviewQueue(store, project, "Stale", [
    "- Finding older than its decay window",
  ]), "append stale queue");
});
snapshot("review-seeded.md", `${project}/review.md`);

const queue = must(access.readReviewQueue(store, project), "read review queue");
writeJson("review-parsed.json", queue.data);

// Approve the first item, snapshot; then reject the second (which also
// touches FINDINGS.md — tolerated there since these entries aren't in it).
//
// Approving a candidate that isn't already in FINDINGS.md promotes it there
// via the same addFindingToFile this script calls directly elsewhere
// (access.ts:906) — but access.ts isn't this script's to change, so that
// internal call never sees this script's now/idSource overrides and would
// otherwise stamp a real fid/timestamp into FINDINGS.md. Nothing here reads
// review-after-approve.md's *content* back out of FINDINGS.md, so this was
// invisible until fixtures further below started re-snapshotting the whole
// file — frozen the same way as every other not-this-script's-file source
// of nondeterminism above.
//
// Two ids, not one: addFindingToFile unconditionally prepares a "new file"
// bullet first (learning.ts:365) even when the file already exists (as it
// does here) and only uses that result if it didn't — so every call against
// an existing file consumes one randomBytes call that is thrown away before
// the one that is actually kept. Every other call in this script survives
// that unscathed because its idSource is a constant-returning closure, not
// this global queue; this is the one call with no override at all.
withFrozenDate("2026-07-26T13:00:00.000Z", () => {
  withFixedIds(["0000c001", "0000c001"], () =>
    must(access.approveQueueItem(store, project, queue.data[0].line), "approve queue item"));
});
snapshot("review-after-approve.md", `${project}/review.md`);

must(access.rejectQueueItem(store, project, queue.data[1].line), "reject queue item");
snapshot("review-after-reject.md", `${project}/review.md`);

const queue2 = must(access.readReviewQueue(store, project), "re-read review queue");
must(access.editQueueItem(store, project, queue2.data[0].line, "Edited stale entry text"), "edit queue item");
snapshot("review-after-edit.md", `${project}/review.md`);

// --- notes ------------------------------------------------------------------

const noteDate = "2026-07-25";
const noteTime = new Date("2026-07-25T14:30:05.000Z");
// `data/notes.ts` takes an injected clock (`now`) but generates its own
// `nid` from a bare `crypto.randomBytes(4)` with no override — same
// not-this-script's-file situation as tasks.ts below, same fix.
const n1 = withFixedIds(["688893f1"], () =>
  must(notes.addNote(store, project, "First note of the day\n\nWith a second paragraph.", { date: noteDate, now: noteTime }), "add note 1"));
withFixedIds(["5588c05d"], () =>
  must(notes.addNote(store, project, "Second note, single line", { date: noteDate, now: new Date("2026-07-25T15:00:00.000Z") }), "add note 2"));
snapshot("notes-after-add.md", `${project}/notes/${noteDate}.md`);

must(notes.editNote(store, project, n1.data.stableId, "First note, edited"), "edit note");
must(notes.markNotePromoted(store, project, n1.data.stableId), "mark promoted");
snapshot("notes-after-edit-promote.md", `${project}/notes/${noteDate}.md`);

const parsedNotes = must(notes.listNotes(store, project), "list notes");
writeJson("notes-parsed.json", parsedNotes.data.map(({ path: _p, ...rest }) => rest));

// --- tasks.md ---------------------------------------------------------------

// `data/tasks.ts` takes an injected `createdAt` string but generates its own
// `bid` from a bare `crypto.randomBytes(4)` with no override parameter, and
// that file isn't this script's to change — so each call gets its own fixed
// id the same way the team journal above gets a fixed clock.
withFixedIds(["aa853063"], () =>
  must(tasks.addTask(store, project, "Ship the iOS app [high]", { createdAt: "2026-07-20T10:00:00.000Z" }), "add task 1"));
withFixedIds(["58b9b427"], () =>
  must(tasks.addTask(store, project, "Write fixture generator", { createdAt: "2026-07-21T10:00:00.000Z" }), "add task 2"));
withFixedIds(["013d708f"], () =>
  must(tasks.addTask(store, project, "Investigate flaky sync test [low]", { createdAt: "2026-07-22T10:00:00.000Z" }), "add task 3"));
snapshot("tasks-after-add.md", `${project}/tasks.md`);

must(tasks.completeTask(store, project, "Write fixture generator"), "complete task");
snapshot("tasks-after-complete.md", `${project}/tasks.md`);

must(tasks.updateTask(store, project, "Investigate flaky sync test", { text: "Investigate flaky sync test on CI", priority: "medium", section: "Active" }), "update task");
snapshot("tasks-after-update.md", `${project}/tasks.md`);

const parsedTasks = must(tasks.readTasks(store, project), "read tasks");
const { path: _p, ...taskDoc } = parsedTasks.data;
writeJson("tasks-parsed.json", taskDoc);

// --- Conformance gaps (docs/store-format.md §7) -----------------------------
//
// Everything below closes one of the five fixture-corpus gaps the spec
// calls out. Each is additive — appended after every snapshot above has
// already been taken — so none of the existing fixtures shift.

// Gap 1 (§2.1): an unrecognised metadata comment must survive an edit
// verbatim. This is the format's most important invariant and, per the
// spec, nothing currently tests it: a "cleaner" reimplementation that
// round-trips through a typed model would silently drop it instead.
must(learning.addFindingToFile(store, project, "Unknown metadata comments must survive edits verbatim", undefined, {
  extraAnnotations: ['<!-- someday:field "x" -->'],
  now: new Date("2026-07-27T09:00:00.000Z"),
  idSource: () => "0000a001",
}), "add finding with unrecognised annotation");
snapshot("findings-unknown-annotation-after-add.md", `${project}/FINDINGS.md`);
must(access.editFinding(store, project, "Unknown metadata comments must survive edits verbatim", "Edited text after an unrecognised annotation round trip"), "edit finding with unrecognised annotation");
snapshot("findings-unknown-annotation-after-edit.md", `${project}/FINDINGS.md`);

// Gap 2 (§5.2): a legacy <details> archive block. Recognised by both
// readers, written by neither — so unlike every fixture above, this one
// cannot come from calling a real mutator. It's authored directly, then fed
// through the real reader so both languages still get one committed ground
// truth for "recognised but never emitted," rather than each hand-rolling
// their own guess at the shape.
const detailsArchiveContent = `# ${project} Findings

## 2026-07-24

- Active finding outside any archive block <!-- fid:00001234 --> <!-- created: 2026-07-24 --> <!-- phren:status "active" -->

<details>
<summary>Archived</summary>

## 2026-01-05

- Archived finding inside a legacy details block <!-- fid:0000abcd --> <!-- phren:status "superseded" --> <!-- phren:status_updated "2026-01-06" --> <!-- phren:status_reason "superseded_by" --> <!-- phren:status_ref "replacement text" -->

</details>
`;
fs.writeFileSync(path.join(fixturesDir, "findings-legacy-details-archive.md"), detailsArchiveContent);
console.log("wrote findings-legacy-details-archive.md (hand-authored — see docs/store-format.md §5.2)");
{
  const detailsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-details-fixture-"));
  fs.writeFileSync(path.join(detailsTmpDir, "phren.root.yaml"), "installMode: shared\nsyncMode: workspace-git\n");
  fs.mkdirSync(path.join(detailsTmpDir, project), { recursive: true });
  fs.writeFileSync(path.join(detailsTmpDir, project, "FINDINGS.md"), detailsArchiveContent);
  const defaultRead = must(access.readFindings(detailsTmpDir, project), "read legacy details (default)");
  const includingArchived = must(access.readFindings(detailsTmpDir, project, { includeArchived: true }), "read legacy details (includeArchived)");
  writeJson("findings-legacy-details-archive-default-parsed.json", defaultRead.data);
  writeJson("findings-legacy-details-archive-with-archived-parsed.json", includingArchived.data);
  fs.rmSync(detailsTmpDir, { recursive: true, force: true });
}

// Gap 3 (§6): a [bracket] prefix outside every known vocabulary (offered,
// decay-tracked, or auto-detected) must not be mangled — readers accept any
// [a-z][a-z0-9_-]* tag, and editFinding's tag-preservation regex is equally
// unpicky, so an edit that supplies no tag of its own must still keep it.
must(learning.addFindingToFile(store, project, "[nonstandard] Bracket tags outside every known vocabulary must not be mangled", undefined, {
  now: new Date("2026-07-27T09:05:00.000Z"),
  idSource: () => "0000a002",
}), "add finding with nonstandard tag");
snapshot("findings-nonstandard-tag-after-add.md", `${project}/FINDINGS.md`);
must(access.editFinding(store, project, "Bracket tags outside every known vocabulary must not be mangled", "Edited text without supplying any tag of its own"), "edit finding with nonstandard tag");
snapshot("findings-nonstandard-tag-after-edit.md", `${project}/FINDINGS.md`);

// Gap 4 (§4.2): a task carrying both priority and pinned state, edited by
// text only. `updateTask` recomputes priority/pinned from the *new* text
// every time text changes — pin the actual (documented-as-rough) behaviour:
// a rename with no re-supplied tags silently drops both.
withFixedIds(["0000b001"], () =>
  must(tasks.addTask(store, project, "Ship urgent fix [high]", { createdAt: "2026-07-23T10:00:00.000Z" }), "add task 4 (pin/priority gap)"));
must(tasks.pinTask(store, project, "Ship urgent fix"), "pin task 4");
snapshot("tasks-pinned-before-text-edit.md", `${project}/tasks.md`);
must(tasks.updateTask(store, project, "Ship urgent fix", { text: "Ship urgent fix (renamed)" }), "text-only update on pinned+prioritised task");
snapshot("tasks-pinned-after-text-only-edit.md", `${project}/tasks.md`);

// Gap 5 (§2.2, §4.3): text long enough and Unicode-rich enough to cross the
// 500-unit review-queue and 60-unit supersedes/superseded_by truncation
// boundaries, counted in UTF-16 code units (JS's `.length`/`.slice`) rather
// than Unicode scalars or grapheme clusters. Each string plants a CANARY
// right past its boundary so truncation landing in the wrong place (e.g.
// counting graphemes, where 200 astral emoji are 200 units short of where
// UTF-16 counts them) is a visible test failure, not a fuzzy length check.
const UNICODE_REVIEW_TEXT = "🧵".repeat(200) + "x".repeat(200) + "CANARY-MUST-NOT-SURVIVE-TRUNCATION" + "y".repeat(200);
withFrozenDate("2026-07-29T09:00:00.000Z", () => {
  must(policy.appendReviewQueue(store, project, "Review", [UNICODE_REVIEW_TEXT]), "append unicode review entry");
});
snapshot("review-unicode-boundary.md", `${project}/review.md`);
{
  const unicodeQueue = must(access.readReviewQueue(store, project), "read unicode review queue");
  const entry = unicodeQueue.data.find((item) => item.text.startsWith("🧵"));
  writeJson("review-unicode-boundary-parsed.json", entry ? [entry] : []);
}

const UNICODE_OLD_FINDING = "🧵🧵🧵🧵🧵" + "x".repeat(50) + "CANARY-MUST-NOT-SURVIVE-60-TRUNCATION";
const UNICODE_NEW_FINDING = "🧵🧵🧵" + "z".repeat(80) + "NEW-FINDING-TAIL";
must(learning.addFindingToFile(store, project, UNICODE_OLD_FINDING, undefined, {
  now: new Date("2026-07-27T09:10:00.000Z"),
  idSource: () => "0000a003",
}), "add finding to be superseded (unicode)");
snapshot("findings-unicode-supersede-before.md", `${project}/FINDINGS.md`);
must(learning.addFindingToFile(store, project, UNICODE_NEW_FINDING, { supersedes: UNICODE_OLD_FINDING }, {
  now: new Date("2026-07-27T09:11:00.000Z"),
  idSource: () => "0000a004",
}), "add superseding finding (unicode)");
snapshot("findings-unicode-supersede-after.md", `${project}/FINDINGS.md`);
{
  const supersedeRead = must(access.readFindings(store, project), "read unicode supersede findings");
  const oldEntry = supersedeRead.data.find((f) => f.stableId === "0000a003");
  const newEntry = supersedeRead.data.find((f) => f.stableId === "0000a004");
  writeJson("findings-unicode-supersede-parsed.json", { old: oldEntry, new: newEntry });
}

skillState.setSkillEnabled(store, "myproj", "Audit.MD", false);
skillState.setSkillEnabled(store, "global", "audit", true);
snapshot("skill-preferences.json", skillState.SKILL_PREFERENCES_PATH);

// Graph identity must survive fixture regeneration too: derive hashes from
// the same CLI functions that build desktop graph nodes.
const graphSamples = [
  ["myproj", "FINDINGS.md", "[pattern] Use the shared cache for repeated lookups"],
  ["myproj", "FINDINGS.md", "Plain untagged finding with enough length"],
  ["myproj", "FINDINGS.md", "[pitfall] Use the shared cache for repeated lookups"],
  ["other-proj", "tasks.md", "Ship the iOS app"],
  ["myproj", "FINDINGS.md", "[bug]   collapses\n   runs   of\twhitespace"],
  ["myproj", "FINDINGS.md", "[decision] " + "x".repeat(300)],
];
writeJson("graph-identity.json", graphSamples.map(([project, filename, snippet]) => {
  const scoreKey = entryScoreKey(project, filename, snippet);
  return { project, filename, snippet, scoreKey, nodeId: findingStableId(scoreKey) };
}));

fs.rmSync(store, { recursive: true, force: true });
console.log("done");
