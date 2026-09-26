import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyEdit, applyEdits, describeNotFound } from "../tools/edit-engine.js";
import { editFileTool, multiEditTool } from "../tools/edit-file.js";
import { modelVisibleOutput } from "../agent-loop/stream.js";
import { DIFF_MARKER } from "../multi/diff-renderer.js";
import { readFileTool } from "../tools/read-file.js";

function ok(r: ReturnType<typeof applyEdit>): string {
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return r.content;
}
function err(r: ReturnType<typeof applyEdit>): string {
  if (r.ok) throw new Error("expected failure");
  return r.error;
}

describe("applyEdit matching", () => {
  it("replaces a unique exact match and reports the edited line", () => {
    const r = applyEdit("a\nb\nc\n", { old_string: "b", new_string: "B" });
    expect(ok(r)).toBe("a\nB\nc\n");
    expect(r.ok && r.firstLine).toBe(2);
  });

  it("replace_all changes every occurrence", () => {
    const r = applyEdit("x = foo(foo)\nfoo\n", { old_string: "foo", new_string: "bar", replace_all: true });
    expect(ok(r)).toBe("x = bar(bar)\nbar\n");
    expect(r.ok && r.replacements).toBe(3);
  });

  it("names the lines of an ambiguous match and suggests replace_all", () => {
    const e = err(applyEdit("foo\nbar\nfoo\n", { old_string: "foo", new_string: "baz" }));
    expect(e).toContain("matches 2 locations (lines 1, 3)");
    expect(e).toContain("replace_all");
  });

  it("rejects identical old and new strings", () => {
    expect(err(applyEdit("a", { old_string: "a", new_string: "a" }))).toMatch(/identical/);
  });

  it("writes $ sequences literally", () => {
    expect(ok(applyEdit("x\n", { old_string: "x", new_string: "$& $1 $$" }))).toBe("$& $1 $$\n");
  });

  it("edits a CRLF file when the model sends LF, keeping CRLF", () => {
    const file = "line one\r\nline two\r\nline three\r\n";
    const out = ok(applyEdit(file, { old_string: "line one\nline two", new_string: "first\nsecond" }));
    expect(out).toBe("first\r\nsecond\r\nline three\r\n");
  });

  it("matches when only trailing whitespace differs", () => {
    const file = "function f() {   \n  return 1;\n}\n";
    const r = applyEdit(file, { old_string: "function f() {\n  return 1;", new_string: "function f() {\n  return 2;" });
    expect(ok(r)).toBe("function f() {\n  return 2;\n}\n");
    expect(r.ok && r.note).toMatch(/trailing whitespace/);
  });

  it("matches with wrong indentation and re-indents new_string to the file", () => {
    const file = "class A {\n    method() {\n        return 1;\n    }\n}\n";
    const r = applyEdit(file, {
      old_string: "method() {\n    return 1;\n}",
      new_string: "method() {\n    return 2;\n}",
    });
    expect(ok(r)).toBe("class A {\n    method() {\n        return 2;\n    }\n}\n");
    expect(r.ok && r.note).toMatch(/indentation/);
  });

  it("strips read_file line-number prefixes copied into old_string", () => {
    const r = applyEdit("alpha\nbeta\ngamma\n", { old_string: "2\tbeta\n3\tgamma", new_string: "2\tBETA\n3\tgamma" });
    expect(ok(r)).toBe("alpha\nBETA\ngamma\n");
    expect(r.ok && r.note).toMatch(/line-number prefixes/);
  });

  it("does not fuzzy-match when the loose match is ambiguous", () => {
    const e = err(applyEdit("  x = 1\n    x = 1\n", { old_string: "\tx = 1", new_string: "x = 2" }));
    expect(e).toContain("matches 2 locations (lines 1, 2)");
    expect(e).toContain("ignoring indentation");
  });

  it("shows the closest region and the first differing line when nothing matches", () => {
    const file = ["import x from 'x';", "", "export function total(items) {", "  let sum = 0;", "  for (const i of items) sum += i.price;", "  return sum;", "}"].join("\n");
    const e = err(applyEdit(file, {
      old_string: "export function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.cost;",
      new_string: "x",
    }));
    expect(e).toContain("old_string was not found");
    expect(e).toContain("Closest match: lines 3-5");
    expect(e).toContain("First difference at line 5");
    expect(e).toContain("i.price");
    expect(e).toContain("Re-read the file");
  });

  it("stays fast on a large file with no match", () => {
    const big = Array.from({ length: 50_000 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const started = Date.now();
    const msg = describeNotFound(big, "something entirely different\nand another line");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(msg).toContain("not found");
  });
});

describe("applyEdits (multi-edit)", () => {
  it("applies edits in order against the running result", () => {
    const r = applyEdits("a b c", [
      { old_string: "a", new_string: "x" },
      { old_string: "x b", new_string: "y" },
    ]);
    expect(ok(r)).toBe("y c");
  });

  it("fails as a whole and names the failing edit", () => {
    const e = err(applyEdits("a b c", [
      { old_string: "a", new_string: "x" },
      { old_string: "zzz", new_string: "q" },
    ]));
    expect(e).toContain("Edit 2 of 2 failed");
    expect(e).toContain("No changes were written");
  });
});

describe("edit tools on disk", () => {
  let dir: string;
  const cwd = process.cwd();
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edit-engine-")));
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("edit_file returns a numbered excerpt, and the diff payload is not model-visible", async () => {
    fs.writeFileSync("f.ts", "one\ntwo\nthree\n");
    const r = await editFileTool.execute({ path: "f.ts", old_string: "two", new_string: "TWO" });
    expect(r.is_error).toBeFalsy();
    expect(r.output).toContain(DIFF_MARKER);
    const visible = modelVisibleOutput(r.output);
    expect(visible).not.toContain(DIFF_MARKER);
    expect(visible).toContain("1 replacement");
    expect(visible).toContain("2\tTWO");
    expect(fs.readFileSync("f.ts", "utf-8")).toBe("one\nTWO\nthree\n");
  });

  it("edit_file with replace_all", async () => {
    fs.writeFileSync("g.ts", "a\na\n");
    const r = await editFileTool.execute({ path: "g.ts", old_string: "a", new_string: "b", replace_all: true });
    expect(r.is_error).toBeFalsy();
    expect(fs.readFileSync("g.ts", "utf-8")).toBe("b\nb\n");
  });

  it("multi_edit writes nothing when any edit fails", async () => {
    fs.writeFileSync("h.ts", "keep\n");
    const r = await multiEditTool.execute({
      path: "h.ts",
      edits: [{ old_string: "keep", new_string: "changed" }, { old_string: "missing", new_string: "x" }],
    });
    expect(r.is_error).toBe(true);
    expect(fs.readFileSync("h.ts", "utf-8")).toBe("keep\n");
  });

  it("multi_edit applies all edits in one write", async () => {
    fs.writeFileSync("m.ts", "let a = 1;\nlet b = 2;\n");
    const r = await multiEditTool.execute({
      path: "m.ts",
      edits: [{ old_string: "a = 1", new_string: "a = 10" }, { old_string: "b = 2", new_string: "b = 20" }],
    });
    expect(r.is_error).toBeFalsy();
    expect(fs.readFileSync("m.ts", "utf-8")).toBe("let a = 10;\nlet b = 20;\n");
  });

  it("points a missing file at write_file", async () => {
    const r = await editFileTool.execute({ path: "nope.ts", old_string: "a", new_string: "b" });
    expect(r.output).toMatch(/write_file/);
  });
});

describe("read_file windows", () => {
  let dir: string;
  const cwd = process.cwd();
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "read-file-")));
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses binary files", async () => {
    fs.writeFileSync("b.bin", Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const r = await readFileTool.execute({ path: "b.bin" });
    expect(r.is_error).toBe(true);
    expect(r.output).toMatch(/binary/);
  });

  it("truncates very long lines and says so", async () => {
    fs.writeFileSync("min.js", `${"x".repeat(10_000)}\nshort\n`);
    const r = await readFileTool.execute({ path: "min.js" });
    expect(r.output).toContain("[line truncated: 10000 chars]");
    expect(r.output).toContain("2\tshort");
    expect(r.output.length).toBeLessThan(3_000);
  });

  it("tells the model where to continue a partial read", async () => {
    fs.writeFileSync("l.txt", Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n"));
    const r = await readFileTool.execute({ path: "l.txt", offset: 5, limit: 10 });
    expect(r.output).toContain("30 total lines, showing 5-14; continue with offset 15");
  });

  it("reports an offset past the end", async () => {
    fs.writeFileSync("s.txt", "a\nb\n");
    const r = await readFileTool.execute({ path: "s.txt", offset: 10 });
    expect(r.is_error).toBe(true);
    expect(r.output).toContain("past the end");
  });

  it("strips CR from CRLF lines", async () => {
    fs.writeFileSync("w.txt", "a\r\nb\r\n");
    const r = await readFileTool.execute({ path: "w.txt" });
    expect(r.output).toBe("1\ta\n2\tb");
  });
});
