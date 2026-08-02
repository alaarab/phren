import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFindings, readReviewQueue } from "../data/access.js";
import { readTasks } from "../data/tasks.js";
import { listNotes } from "../data/notes.js";
import { grantAdmin, makeTempDir, REPO_ROOT } from "../test-helpers.js";

/**
 * The inverse of apps/ios/scripts/generate-fixtures.mjs: that script proves
 * TypeScript writes -> Swift reads. PhrenKit is a full independent writer
 * too (FindingsFile.add/.edit/.remove, TasksFile.add/.complete/.update,
 * ReviewFile.edit/.approve, NotesFile.add/.edit/.markPromoted), and nothing
 * previously proved the CLI's own readers accept what it produces.
 *
 * `SwiftWritesFixturesTests.swift`
 * (apps/ios/PhrenKit/Tests/PhrenKitTests/SwiftWritesFixtures.swift) builds
 * these exact files with PhrenKit's real mutators and, when regenerating
 * (`PHREN_REGENERATE_SWIFT_FIXTURES=1 swift test`), commits them under
 * Fixtures/swift-writes/ alongside the CLI-generated corpus. This file reads
 * the committed result with the CLI's real readers and asserts the parsed
 * shape matches what that Swift test intended — the two files together are
 * the whole conformance claim; neither language can invoke the other
 * directly, so the corpus moving through committed disk state is the
 * mechanism. See docs/store-format.md §7.
 *
 * A `fid`/`bid`/`nid` value below is asserted only by shape
 * (`/^[a-f0-9]{8}$/`), never by exact string: PhrenKit's id generation has no
 * injection seam (unlike `content/learning.ts`'s, added for Task 1 here),
 * so regenerating the Swift side legitimately rotates every id.
 */
const SWIFT_WRITES_DIR = path.join(
  REPO_ROOT,
  "apps/ios/PhrenKit/Tests/PhrenKitTests/Fixtures/swift-writes",
);

const PROJECT = "myproj";
const STABLE_ID = /^[a-f0-9]{8}$/;

let tmpDir: string;
let projectDir: string;
let cleanup: () => void;

beforeEach(() => {
  ({ path: tmpDir, cleanup } = makeTempDir("phren-swift-writes-"));
  projectDir = path.join(tmpDir, PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  grantAdmin(tmpDir);
});

afterEach(() => {
  cleanup();
});

/** Copy a fixture PhrenKit wrote into the temp store under its real CLI name. */
function importSwiftFixture(name: string, destRelPath: string): void {
  const src = path.join(SWIFT_WRITES_DIR, name);
  const dest = path.join(projectDir, destRelPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

describe("Swift-written fixtures read by the CLI (bidirectional conformance)", () => {
  it("readFindings parses FINDINGS.md written by FindingsFile.add/.edit/.remove", () => {
    importSwiftFixture("findings.md", "FINDINGS.md");
    const result = readFindings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // FindingsFile.remove() deleted the "Session tokens expire" finding —
    // only the two survivors should come back.
    expect(result.data).toHaveLength(2);
    expect(result.data.some((f) => f.text.includes("Session tokens expire"))).toBe(false);

    const decision = result.data.find((f) => f.text.startsWith("[decision]"));
    expect(decision?.text).toBe("[decision] Chose async/await over Combine for the sync engine");
    expect(decision?.scope).toBe("builder");
    expect(decision?.status).toBe("active");
    expect(decision?.date).toBe("2026-07-31");
    expect(decision?.stableId).toMatch(STABLE_ID);
    // FindingsFile.isoTimestamp is the Swift port of `new Date().toISOString()`
    // (learning.ts's citation created_at) — fixed test instant, not wall-clock.
    expect(decision?.citationData?.created_at).toBe("2026-07-31T12:13:20.000Z");

    const edited = result.data.find((f) => f.text.startsWith("Edited by PhrenKit"));
    expect(edited?.text).toBe("Edited by PhrenKit after being written by PhrenKit");
    expect(edited?.stableId).toMatch(STABLE_ID);
    // FindingsFile.edit() preserves the fid/created/status comments already
    // on the line (§2.1) — this is the CLI's reader confirming that survived.
    expect(edited?.date).toBe("2026-07-31");
    expect(edited?.status).toBe("active");
  });

  it("readTasks parses tasks.md written by TasksFile.add/.complete/.update", () => {
    importSwiftFixture("tasks.md", "tasks.md");
    const result = readTasks(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.items.Active).toHaveLength(1);
    // §4.2: priority is a dual source of truth — it is both the parsed field
    // AND a literal `[medium]` substring still sitting in `.line`.
    expect(result.data.items.Active[0].line).toBe("Investigate widget refresh timing on iOS 18 [medium]");
    expect(result.data.items.Active[0].priority).toBe("medium");
    expect(result.data.items.Active[0].stableId).toMatch(STABLE_ID);

    expect(result.data.items.Queue).toHaveLength(1);
    expect(result.data.items.Queue[0].line).toBe("Ship the PhrenKit conformance suite [high]");
    expect(result.data.items.Queue[0].priority).toBe("high");
    expect(result.data.items.Queue[0].stableId).toMatch(STABLE_ID);

    expect(result.data.items.Done).toHaveLength(1);
    expect(result.data.items.Done[0].line).toBe("Draft app store notes");
    expect(result.data.items.Done[0].checked).toBe(true);
  });

  it("readReviewQueue parses review.md written by ReviewFile.edit/.approve", () => {
    importSwiftFixture("review.md", "review.md");
    const result = readReviewQueue(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // ReviewFile.approve() dequeued the "Unverified capture" entry entirely —
    // only the edited one should come back.
    expect(result.data).toHaveLength(1);
    expect(result.data[0].section).toBe("Review");
    expect(result.data[0].date).toBe("2026-07-29");
    expect(result.data[0].text).toBe(
      "Edited by PhrenKit: background refresh drops writes when the device sleeps mid-sync",
    );
  });

  it("listNotes parses notes/2026-07-31.md written by NotesFile.add/.edit/.markPromoted", () => {
    importSwiftFixture("notes-2026-07-31.md", "notes/2026-07-31.md");
    const result = listNotes(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toHaveLength(2);
    const first = result.data.find((n) => n.time === "09:15:00");
    expect(first?.text).toBe("First note, edited on the phone");
    expect(first?.promoted).toBe(true);
    expect(first?.stableId).toMatch(STABLE_ID);

    const second = result.data.find((n) => n.time === "09:20:00");
    expect(second?.text).toBe("Second note, quick single line");
    expect(second?.promoted).toBe(false);
  });
});
