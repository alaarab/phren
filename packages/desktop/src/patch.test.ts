// @ts-expect-error patch.js is plain JavaScript without type declarations
import { parsePatch, reverseApply, wordSegments } from "../ui/patch.js";
import { describe, expect, it } from "vitest";

const OLD = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
const NEW = "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nten\n";
const TWO_HUNK = [
  "diff --git a/f.txt b/f.txt",
  "index 1111111..2222222 100644",
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -1,4 +1,4 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  " four",
  "@@ -7,4 +7,4 @@",
  " seven",
  " eight",
  "-nine",
  "+NINE",
  " ten",
  "",
].join("\n");

describe("parsePatch", () => {
  it("numbers both hunks as git does and ignores file headers", () => {
    const hunks = parsePatch(TWO_HUNK);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldCount: 4, newStart: 1, newCount: 4 });
    expect(hunks[1]).toMatchObject({ oldStart: 7, oldCount: 4, newStart: 7, newCount: 4 });
    expect(hunks[0].lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["context", 1, 1], ["del", 2, null], ["add", null, 2], ["context", 3, 3], ["context", 4, 4],
    ]);
    expect(hunks[1].lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["context", 7, 7], ["context", 8, 8], ["del", 9, null], ["add", null, 9], ["context", 10, 10],
    ]);
  });
});

describe("reverseApply", () => {
  it("restores the old text across two hunks", () => {
    expect(reverseApply(NEW, TWO_HUNK)).toBe(OLD);
  });

  it("restores a modify hunk", () => {
    const patch = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
    expect(reverseApply("a\nB\nc\n", patch)).toBe("a\nb\nc\n");
  });

  it("restores an add-only hunk", () => {
    const patch = "@@ -1 +1,2 @@\n a\n+b\n\\ No newline at end of file\n";
    expect(reverseApply("a\nb", patch)).toBe("a\n");
  });

  it("restores a delete-only hunk", () => {
    const patch = "@@ -1,2 +1 @@\n a\n-b\n";
    expect(reverseApply("a\n", patch)).toBe("a\nb\n");
  });

  it("preserves a missing trailing newline the patch marks", () => {
    const patch = "@@ -1,2 +1,2 @@\n a\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
    expect(reverseApply("a\nnew", patch)).toBe("a\nold");
  });

  it("throws when the new text does not match", () => {
    expect(() => reverseApply("x\ny\n", TWO_HUNK)).toThrow("The patch does not match the file.");
  });
});

describe("wordSegments", () => {
  it("marks only the changed word", () => {
    const { old: before, new: after } = wordSegments("let accent = green", "let accent = purple");
    expect(before.filter((s) => s.changed).map((s) => s.text)).toEqual(["green"]);
    expect(after.filter((s) => s.changed).map((s) => s.text)).toEqual(["purple"]);
  });
});
