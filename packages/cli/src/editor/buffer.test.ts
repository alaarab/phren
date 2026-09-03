/**
 * The editor is a pure state machine so its behaviour can be pinned without a
 * terminal. These tests are the specification of the vim subset phren claims
 * to support — if a key is not here, it is not supported.
 */

import { describe, expect, it } from "vitest";
import { applyEditorKey, createEditorState, editorText, type EditorState } from "./buffer.js";

const start = (content: string) => createEditorState("/s/SKILL.md", "SKILL.md", content);
/** Feed a sequence of keys, one per element (so "dd" is ["d","d"]). */
const keys = (state: EditorState, ...ks: string[]): EditorState => ks.reduce(applyEditorKey, state);
const type = (state: EditorState, text: string): EditorState => [...text].reduce(applyEditorKey, state);

describe("createEditorState", () => {
  it("treats a trailing newline as a terminator, not an empty last line", () => {
    expect(start("a\nb\n").lines).toEqual(["a", "b"]);
    expect(start("a\nb").lines).toEqual(["a", "b"]);
    expect(start("").lines).toEqual([""]);
  });

  it("always writes back exactly one trailing newline", () => {
    expect(editorText(start("a\nb\n"))).toBe("a\nb\n");
    expect(editorText(start("a\nb"))).toBe("a\nb\n");
  });
});

describe("motion", () => {
  const s = start("hello world\nsecond line\nthird");

  it("moves by character and line, with arrows as aliases", () => {
    expect(keys(s, "l", "l").cursor).toEqual({ line: 0, col: 2 });
    expect(keys(s, "j").cursor).toEqual({ line: 1, col: 0 });
    expect(keys(s, "j", "k").cursor).toEqual({ line: 0, col: 0 });
    expect(keys(s, "\x1b[C", "\x1b[B").cursor).toEqual({ line: 1, col: 1 });
  });

  it("stops at the edges rather than wrapping", () => {
    expect(keys(s, "h", "h").cursor).toEqual({ line: 0, col: 0 });
    expect(keys(s, "k").cursor).toEqual({ line: 0, col: 0 });
    expect(keys(s, "j", "j", "j", "j").cursor.line).toBe(2);
  });

  it("in normal mode the cursor sits on a character, not past the end", () => {
    // "third" is 5 characters, so $ lands on index 4.
    expect(keys(s, "j", "j", "$").cursor).toEqual({ line: 2, col: 4 });
  });

  it("0 and $ jump within the line, gg and G between them", () => {
    expect(keys(s, "$", "0").cursor).toEqual({ line: 0, col: 0 });
    expect(keys(s, "G").cursor.line).toBe(2);
    expect(keys(s, "G", "g", "g").cursor).toEqual({ line: 0, col: 0 });
  });

  it("w and b step over words", () => {
    expect(keys(s, "w").cursor).toEqual({ line: 0, col: 6 });
    expect(keys(s, "w", "b").cursor).toEqual({ line: 0, col: 0 });
  });

  it("a lone g does nothing and does not stick", () => {
    const after = keys(s, "g", "l");
    expect(after.pending).toBe("");
    expect(after.cursor).toEqual({ line: 0, col: 0 });
  });
});

describe("insert mode", () => {
  it("i inserts at the cursor and Esc steps back onto a character", () => {
    const s = type(keys(start("bc"), "i"), "a");
    expect(s.lines).toEqual(["abc"]);
    expect(s.dirty).toBe(true);
    const done = applyEditorKey(s, "\x1b");
    expect(done.mode).toBe("normal");
    expect(done.cursor).toEqual({ line: 0, col: 0 });
  });

  it("a, I and A start from the right place", () => {
    expect(type(keys(start("ac"), "a"), "b").lines).toEqual(["abc"]);
    expect(type(keys(start("bc"), "I"), "a").lines).toEqual(["abc"]);
    expect(type(keys(start("ab"), "A"), "c").lines).toEqual(["abc"]);
  });

  it("o and O open a line and leave you typing on it", () => {
    const below = type(keys(start("one\ntwo"), "o"), "new");
    expect(below.lines).toEqual(["one", "new", "two"]);
    expect(below.mode).toBe("insert");
    expect(type(keys(start("one"), "O"), "zero").lines).toEqual(["zero", "one"]);
  });

  it("Enter splits a line and Backspace joins it back", () => {
    const split = applyEditorKey(keys(start("ab"), "l", "i"), "\r");
    expect(split.lines).toEqual(["a", "b"]);
    expect(split.cursor).toEqual({ line: 1, col: 0 });
    const joined = applyEditorKey(split, "\x7f");
    expect(joined.lines).toEqual(["ab"]);
    expect(joined.cursor).toEqual({ line: 0, col: 1 });
  });

  it("Backspace at the very start does nothing", () => {
    const s = applyEditorKey(keys(start("ab"), "i"), "\x7f");
    expect(s.lines).toEqual(["ab"]);
  });

  it("ignores control sequences instead of inserting garbage", () => {
    const s = applyEditorKey(keys(start("ab"), "i"), "\x1b[200~");
    expect(s.lines).toEqual(["ab"]);
  });
});

describe("edits", () => {
  it("x deletes the character under the cursor", () => {
    expect(keys(start("abc"), "x").lines).toEqual(["bc"]);
    // And does nothing on an empty line rather than throwing.
    expect(keys(start(""), "x").lines).toEqual([""]);
  });

  it("dd deletes a line and keeps it for p", () => {
    const cut = keys(start("one\ntwo\nthree"), "j", "d", "d");
    expect(cut.lines).toEqual(["one", "three"]);
    expect(cut.register).toEqual(["two"]);
    const pasted = applyEditorKey(cut, "p");
    expect(pasted.lines).toEqual(["one", "three", "two"]);
  });

  it("dd on the last remaining line leaves an empty buffer, not no buffer", () => {
    expect(keys(start("only"), "d", "d").lines).toEqual([""]);
  });

  it("yy copies without deleting, and P pastes above", () => {
    const yanked = keys(start("one\ntwo"), "y", "y");
    expect(yanked.lines).toEqual(["one", "two"]);
    expect(yanked.dirty).toBe(false);
    expect(applyEditorKey(yanked, "P").lines).toEqual(["one", "one", "two"]);
  });

  it("p with nothing yanked does nothing", () => {
    expect(keys(start("one"), "p").lines).toEqual(["one"]);
  });
});

describe("undo", () => {
  it("steps back through edits", () => {
    const edited = keys(start("one\ntwo"), "d", "d");
    expect(edited.lines).toEqual(["two"]);
    expect(applyEditorKey(edited, "u").lines).toEqual(["one", "two"]);
  });

  it("undoes typing a character at a time, and says when there is nothing left", () => {
    const typed = type(keys(start("b"), "i"), "aa");
    expect(typed.lines).toEqual(["aab"]);
    const once = applyEditorKey({ ...typed, mode: "normal" }, "u");
    expect(once.lines).toEqual(["ab"]);
    const empty = applyEditorKey(start("x"), "u");
    expect(empty.message).toContain("nothing to undo");
  });
});

describe("search", () => {
  const s = start("alpha\nbeta\ngamma beta");

  it("/ jumps to the first match and n cycles", () => {
    const found = applyEditorKey(type(applyEditorKey(s, "/"), "beta"), "\r");
    expect(found.cursor).toEqual({ line: 1, col: 0 });
    expect(found.search).toBe("beta");
    expect(applyEditorKey(found, "n").cursor).toEqual({ line: 2, col: 6 });
    // And wraps back to the top.
    expect(keys(found, "n", "n").cursor).toEqual({ line: 1, col: 0 });
  });

  it("reports a miss instead of moving", () => {
    const missed = applyEditorKey(type(applyEditorKey(s, "/"), "nowhere"), "\r");
    expect(missed.message).toContain("not found");
    expect(missed.cursor).toEqual({ line: 0, col: 0 });
  });

  it("n without a prior search says so", () => {
    expect(applyEditorKey(s, "n").message).toContain("press / first");
  });
});

describe("commands", () => {
  it(":w asks to save, :wq asks for both", () => {
    const saved = applyEditorKey(type(applyEditorKey(start("x"), ":"), "w"), "\r");
    expect(saved.wantSave).toBe(true);
    expect(saved.wantClose).toBe(false);
    const both = applyEditorKey(type(applyEditorKey(start("x"), ":"), "wq"), "\r");
    expect(both).toMatchObject({ wantSave: true, wantClose: true });
  });

  it(":q refuses to discard unsaved work, :q! does it anyway", () => {
    const dirty = keys(start("one\ntwo"), "d", "d");
    const refused = applyEditorKey(type(applyEditorKey(dirty, ":"), "q"), "\r");
    expect(refused.wantClose).toBe(false);
    expect(refused.message).toContain("unsaved changes");
    const forced = applyEditorKey(type(applyEditorKey(dirty, ":"), "q!"), "\r");
    expect(forced.wantClose).toBe(true);
  });

  it(":q closes straight away when nothing changed", () => {
    expect(applyEditorKey(type(applyEditorKey(start("x"), ":"), "q"), "\r").wantClose).toBe(true);
  });

  it("names an unknown command rather than guessing", () => {
    const bad = applyEditorKey(type(applyEditorKey(start("x"), ":"), "wqa"), "\r");
    expect(bad.message).toContain("not an editor command");
    expect(bad.wantClose).toBe(false);
  });

  it("Esc abandons a command, and backspacing past the colon leaves the line", () => {
    expect(applyEditorKey(type(applyEditorKey(start("x"), ":"), "w"), "\x1b").mode).toBe("normal");
    const backed = applyEditorKey(applyEditorKey(start("x"), ":"), "\x7f");
    expect(backed.mode).toBe("normal");
    expect(backed.command).toBe("");
  });
});

describe("unknown keys", () => {
  it("are ignored rather than approximated", () => {
    const s = start("hello");
    for (const key of ["z", "Z", "!", "\x01", "\x1b[5~"]) {
      const after = applyEditorKey(s, key);
      expect(after.lines).toEqual(s.lines);
      expect(after.cursor).toEqual(s.cursor);
      expect(after.dirty).toBe(false);
    }
  });
});
