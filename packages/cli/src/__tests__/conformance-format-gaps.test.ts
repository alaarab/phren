import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFindings, editFinding, removeFinding, readReviewQueue } from "../data/access.js";
import { readTasks, updateTask } from "../data/tasks.js";
import { addFindingToFile } from "../content/learning.js";
import { FINDING_TAGS } from "../phren-core.js";
import { grantAdmin, makeTempDir, REPO_ROOT } from "../test-helpers.js";

/**
 * docs/store-format.md §7 lists five scenarios the fixture corpus didn't
 * cover, each a real rough edge in the format rather than a hypothetical
 * one. This file closes all five on the TypeScript side, reading the same
 * committed fixtures PhrenKitTests/FormatGapsTests.swift reads on the Swift
 * side (apps/ios/PhrenKit/Tests/PhrenKitTests/Fixtures/) so both languages
 * are asserting against identical bytes, not independently-authored guesses
 * at the same scenario.
 */
const FIXTURES_DIR = path.join(REPO_ROOT, "apps/ios/PhrenKit/Tests/PhrenKitTests/Fixtures");
const PROJECT = "myproj";

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

let tmpDir: string;
let projectDir: string;
let cleanup: () => void;

beforeEach(() => {
  ({ path: tmpDir, cleanup } = makeTempDir("phren-format-gaps-"));
  projectDir = path.join(tmpDir, PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  grantAdmin(tmpDir);
});

afterEach(() => {
  cleanup();
});

describe("format conformance gaps (docs/store-format.md §7)", () => {
  // --- Gap 1 (§2.1): the format's most important invariant — an
  // unrecognised metadata comment must survive a full read-modify-write
  // cycle. A writer that round-trips through a typed model instead of
  // doing surgical string editing would silently destroy it.
  describe("gap 1: unrecognised metadata comment survives an edit verbatim", () => {
    it("keeps the committed fixture's unknown annotation through add and edit", () => {
      const afterAdd = readFixture("findings-unknown-annotation-after-add.md");
      const afterEdit = readFixture("findings-unknown-annotation-after-edit.md");
      expect(afterAdd).toContain('<!-- someday:field "x" -->');
      expect(afterEdit).toContain('<!-- someday:field "x" -->');
      // The edit changed the visible text; the unrecognised comment held still.
      expect(afterEdit).toContain("Edited text after an unrecognised annotation round trip");
      expect(afterEdit).not.toContain("Unknown metadata comments must survive edits verbatim");
    });

    it("preserves a comment addFindingToFile/editFinding have never heard of, on a fresh write", () => {
      // Fixture-independent proof against today's source, not just a
      // frozen snapshot: a "cleaner" reimplementation that parses into a
      // typed record and re-serialises from only the fields it knows would
      // pass the fixture check above right up until the format grows a
      // field this test doesn't already name.
      const add = addFindingToFile(tmpDir, PROJECT, "A finding with an alien annotation", undefined, {
        extraAnnotations: ['<!-- future:field "unreleased" -->'],
      });
      expect(add.ok).toBe(true);

      const edited = editFinding(tmpDir, PROJECT, "A finding with an alien annotation", "Renamed, no annotation supplied");
      expect(edited.ok).toBe(true);

      const content = fs.readFileSync(path.join(projectDir, "FINDINGS.md"), "utf8");
      expect(content).toContain('<!-- future:field "unreleased" -->');
      expect(content).toContain("Renamed, no annotation supplied");
    });
  });

  // --- Gap 2 (§5.2): a legacy <details> archive block — recognised by both
  // readers, written by neither, so the least-exercised parser path. The
  // fixture is hand-authored (nothing produces this shape today) but the
  // parsed JSON alongside it came from calling the real reader.
  describe("gap 2: legacy <details> archive block", () => {
    it("readFindings excludes it by default and includes it with includeArchived", () => {
      fs.copyFileSync(path.join(FIXTURES_DIR, "findings-legacy-details-archive.md"), path.join(projectDir, "FINDINGS.md"));

      const defaultRead = readFindings(tmpDir, PROJECT);
      expect(defaultRead.ok).toBe(true);
      if (!defaultRead.ok) return;
      expect(defaultRead.data).toHaveLength(1);
      expect(defaultRead.data[0].text).toBe("Active finding outside any archive block");
      expect(defaultRead.data[0].tier).toBe("current");

      const withArchived = readFindings(tmpDir, PROJECT, { includeArchived: true });
      expect(withArchived.ok).toBe(true);
      if (!withArchived.ok) return;
      expect(withArchived.data).toHaveLength(2);
      const archived = withArchived.data.find((f) => f.stableId === "0000abcd");
      expect(archived?.text).toBe("Archived finding inside a legacy details block");
      expect(archived?.status).toBe("superseded");
      expect(archived?.status_updated).toBe("2026-01-06");
      expect(archived?.status_reason).toBe("superseded_by");
      expect(archived?.status_ref).toBe("replacement text");
      expect(archived?.tier).toBe("archived");

      // Matches the shared JSON fixture Swift reads too, not just this test's
      // own inline expectations.
      expect(defaultRead.data).toEqual(JSON.parse(readFixture("findings-legacy-details-archive-default-parsed.json")));
      expect(withArchived.data).toEqual(JSON.parse(readFixture("findings-legacy-details-archive-with-archived-parsed.json")));
    });

    it("refuses to edit or remove an entry that lives only inside the archive block", () => {
      fs.copyFileSync(path.join(FIXTURES_DIR, "findings-legacy-details-archive.md"), path.join(projectDir, "FINDINGS.md"));

      const edited = editFinding(tmpDir, PROJECT, "Archived finding inside a legacy details block", "changed");
      expect(edited.ok).toBe(false);

      const removed = removeFinding(tmpDir, PROJECT, "Archived finding inside a legacy details block");
      expect(removed.ok).toBe(false);

      // Refusing means refusing — not a partial or silent edit.
      const content = fs.readFileSync(path.join(projectDir, "FINDINGS.md"), "utf8");
      expect(content).toBe(readFixture("findings-legacy-details-archive.md"));
    });
  });

  // --- Gap 3 (§6): a [bracket] prefix outside every known vocabulary
  // (offered, decay-tracked, or auto-detected) must not be mangled.
  describe("gap 3: [nonstandard] type tag is not mangled", () => {
    it("is not a recognised finding tag — the premise this fixture depends on", () => {
      expect((FINDING_TAGS as readonly string[]).includes("nonstandard")).toBe(false);
    });

    it("survives read and an edit that supplies no tag of its own", () => {
      const afterAdd = readFixture("findings-nonstandard-tag-after-add.md");
      const afterEdit = readFixture("findings-nonstandard-tag-after-edit.md");
      expect(afterAdd).toContain("[nonstandard] Bracket tags outside every known vocabulary must not be mangled");
      expect(afterEdit).toContain("[nonstandard] Edited text without supplying any tag of its own");

      fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), afterAdd);
      const parsed = readFindings(tmpDir, PROJECT);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const entry = parsed.data.find((f) => f.stableId === "0000a002");
      // readFindings never strips or validates the tag against FINDING_TAGS —
      // it comes back as plain text, untouched.
      expect(entry?.text).toBe("[nonstandard] Bracket tags outside every known vocabulary must not be mangled");
    });
  });

  // --- Gap 4 (§4.2): priority and pinned state are a dual source of
  // truth — a substring in the task text AND a parsed field. `updateTask`
  // recomputes both from the *new* text whenever text changes, so a rename
  // that doesn't re-supply them silently drops them. This pins the actual
  // behaviour; it does not fix it.
  describe("gap 4: pinned+prioritised task edited by text only drops both (documented rough edge)", () => {
    it("has priority and pinned state before the text-only edit", () => {
      fs.copyFileSync(path.join(FIXTURES_DIR, "tasks-pinned-before-text-edit.md"), path.join(projectDir, "tasks.md"));
      const before = readTasks(tmpDir, PROJECT);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const item = before.data.items.Queue.find((t) => t.stableId === "0000b001");
      expect(item?.priority).toBe("high");
      expect(item?.pinned).toBe(true);
      expect(item?.line).toBe("Ship urgent fix [high] [pinned]");
    });

    it("ACTUAL behaviour: a text-only rename silently drops both", () => {
      fs.copyFileSync(path.join(FIXTURES_DIR, "tasks-pinned-before-text-edit.md"), path.join(projectDir, "tasks.md"));
      const result = updateTask(tmpDir, PROJECT, "Ship urgent fix", { text: "Ship urgent fix (renamed)" });
      expect(result.ok).toBe(true);

      const after = readTasks(tmpDir, PROJECT);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      const item = after.data.items.Queue.find((t) => t.stableId === "0000b001");
      expect(item?.line).toBe("Ship urgent fix (renamed)");
      expect(item?.priority).toBeUndefined();
      expect(item?.pinned).toBeUndefined();

      // The committed fixture is this exact behaviour, byte for byte.
      const rendered = fs.readFileSync(path.join(projectDir, "tasks.md"), "utf8");
      expect(rendered).toBe(readFixture("tasks-pinned-after-text-only-edit.md"));
    });
  });

  // --- Gap 5 (§2.2, §4.3): lengths and slice offsets are counted in UTF-16
  // code units (JS's `.length`/`.slice`), not Unicode scalars or grapheme
  // clusters. Each fixture plants a CANARY string just past the boundary it
  // should not survive, so a miscounted truncation is a visible failure
  // rather than a fuzzy length check.
  describe("gap 5: UTF-16 code unit counting at the truncation boundaries", () => {
    it("truncates a review queue entry at 500 UTF-16 units, not codepoints/graphemes", () => {
      const content = readFixture("review-unicode-boundary.md");
      const match = content.match(/^- \[2026-07-29\] (.+)$/m);
      expect(match).not.toBeNull();
      const stored = match![1];

      expect(stored.length).toBe(500); // JS .length counts UTF-16 units
      expect(stored.endsWith("…")).toBe(true);
      expect(stored).not.toContain("CANARY");
      // All 200 astral emoji (400 of the 500 units) survive whole — the cut
      // lands 99 plain "x" characters into the text after them, nowhere
      // near splitting one.
      expect((stored.match(/🧵/gu) || []).length).toBe(200);

      const parsedFixture = JSON.parse(readFixture("review-unicode-boundary-parsed.json"));
      expect(parsedFixture[0].text).toBe(stored);

      // Independent of the committed JSON: readReviewQueue on the same
      // committed .md, called fresh, agrees.
      fs.writeFileSync(path.join(projectDir, "review.md"), content);
      const reread = readReviewQueue(tmpDir, PROJECT);
      expect(reread.ok).toBe(true);
      if (!reread.ok) return;
      expect(reread.data.find((i) => i.text === stored)).toBeDefined();
    });

    it("truncates phren:supersedes/superseded_by to 60 UTF-16 units, canary excluded", () => {
      const parsedFixture = JSON.parse(readFixture("findings-unicode-supersede-parsed.json"));
      expect(parsedFixture.old.supersededBy.length).toBe(60);
      expect(parsedFixture.old.supersededBy).not.toContain("NEW-FINDING-TAIL");
      expect(parsedFixture.new.supersedes.length).toBe(60);
      expect(parsedFixture.new.supersedes).not.toContain("CANARY");

      // Reading the committed fixture with today's source reproduces the
      // same 60-unit boundary independent of the JSON snapshot above.
      fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), readFixture("findings-unicode-supersede-after.md"));
      const reread = readFindings(tmpDir, PROJECT);
      expect(reread.ok).toBe(true);
      if (!reread.ok) return;
      const oldEntry = reread.data.find((f) => f.stableId === "0000a003");
      const newEntry = reread.data.find((f) => f.stableId === "0000a004");
      expect(oldEntry?.supersededBy?.length).toBe(60);
      expect(newEntry?.supersedes?.length).toBe(60);
      // The finding's own visible text is never truncated — only the
      // cross-reference comments are. Both CANARY/TAIL markers are still
      // present in the full text.
      expect(oldEntry?.text).toContain("CANARY-MUST-NOT-SURVIVE-60-TRUNCATION");
      expect(newEntry?.text).toContain("NEW-FINDING-TAIL");
    });
  });
});
