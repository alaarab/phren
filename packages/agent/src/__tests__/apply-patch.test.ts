import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyChunks, applyPatchTool, parsePatch, PatchError } from "../tools/apply-patch.js";
import { checkPermission } from "../permissions/checker.js";

describe("parsePatch", () => {
  it("parses add, delete, update and move operations", () => {
    const ops = parsePatch([
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+hello",
      "*** Delete File: old.txt",
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "@@ function f() {",
      "-  return 1;",
      "+  return 2;",
      "*** End Patch",
    ].join("\n"));
    expect(ops.map((o) => o.kind)).toEqual(["add", "delete", "update"]);
    expect(ops[2]).toMatchObject({ path: "src/a.ts", moveTo: "src/b.ts" });
  });

  it("accepts a heredoc wrapper and a hunk without @@", () => {
    const ops = parsePatch("apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: a\n-x\n+y\n*** End Patch\nEOF\n");
    expect(ops).toHaveLength(1);
  });

  it("rejects a patch without the Begin marker", () => {
    expect(() => parsePatch("*** Update File: a\n-x\n+y")).toThrow(PatchError);
  });

  it("rejects Add File lines without '+'", () => {
    expect(() => parsePatch("*** Begin Patch\n*** Add File: a\nno plus\n*** End Patch")).toThrow(/must start with '\+'/);
  });
});

describe("applyChunks", () => {
  const file = "import a;\n\nfunction f() {\n  return 1;\n}\n\nfunction g() {\n  return 1;\n}\n";

  it("uses the @@ anchor to pick between identical hunks", () => {
    const [op] = parsePatch("*** Begin Patch\n*** Update File: x\n@@ function g() {\n-  return 1;\n+  return 2;\n*** End Patch");
    if (op.kind !== "update") throw new Error();
    expect(applyChunks(file, op.chunks, "x")).toBe(file.replace("g() {\n  return 1;", "g() {\n  return 2;"));
  });

  it("tolerates trailing-whitespace and typographic-quote drift in context", () => {
    const src = "const s = “hi”;   \nconst t = 1;\n";
    const [op] = parsePatch("*** Begin Patch\n*** Update File: x\n@@\n const s = \"hi\";\n-const t = 1;\n+const t = 2;\n*** End Patch");
    if (op.kind !== "update") throw new Error();
    expect(applyChunks(src, op.chunks, "x")).toBe("const s = “hi”;   \nconst t = 2;\n");
  });

  it("explains a hunk that does not apply with the closest region", () => {
    const [op] = parsePatch("*** Begin Patch\n*** Update File: x\n@@\n function f() {\n-  return 7;\n+  return 8;\n*** End Patch");
    if (op.kind !== "update") throw new Error();
    expect(() => applyChunks(file, op.chunks, "x")).toThrow(/hunk 1 did not apply[\s\S]*Closest match/);
  });

  it("keeps CRLF line endings", () => {
    const [op] = parsePatch("*** Begin Patch\n*** Update File: x\n@@\n-b\n+B\n*** End Patch");
    if (op.kind !== "update") throw new Error();
    expect(applyChunks("a\r\nb\r\nc\r\n", op.chunks, "x")).toBe("a\r\nB\r\nc\r\n");
  });
});

describe("apply_patch tool", () => {
  let dir: string;
  const cwd = process.cwd();
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "apply-patch-")));
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("adds, updates, moves and deletes files in one call", async () => {
    fs.mkdirSync("src");
    fs.writeFileSync("src/a.ts", "export const a = 1;\nexport const keep = true;\n");
    fs.writeFileSync("gone.txt", "bye\n");
    const r = await applyPatchTool.execute({
      patch: [
        "*** Begin Patch",
        "*** Add File: src/new.ts",
        "+export const n = 1;",
        "*** Update File: src/a.ts",
        "*** Move to: src/b.ts",
        "@@",
        "-export const a = 1;",
        "+export const a = 2;",
        " export const keep = true;",
        "*** Delete File: gone.txt",
        "*** End Patch",
      ].join("\n"),
    });
    expect(r.is_error).toBeFalsy();
    expect(r.output).toContain("A src/new.ts");
    expect(fs.readFileSync("src/new.ts", "utf-8")).toBe("export const n = 1;\n");
    expect(fs.existsSync("src/a.ts")).toBe(false);
    expect(fs.readFileSync("src/b.ts", "utf-8")).toBe("export const a = 2;\nexport const keep = true;\n");
    expect(fs.existsSync("gone.txt")).toBe(false);
  });

  it("changes nothing when a later hunk fails", async () => {
    fs.writeFileSync("one.txt", "1\n");
    fs.writeFileSync("two.txt", "2\n");
    const r = await applyPatchTool.execute({
      patch: "*** Begin Patch\n*** Update File: one.txt\n-1\n+one\n*** Update File: two.txt\n-missing\n+x\n*** End Patch",
    });
    expect(r.is_error).toBe(true);
    expect(r.output).toContain("no files were changed");
    expect(fs.readFileSync("one.txt", "utf-8")).toBe("1\n");
  });

  it("refuses paths outside the project", async () => {
    const r = await applyPatchTool.execute({ patch: "*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch" });
    expect(r.is_error).toBe(true);
    expect(fs.existsSync(path.join(dir, "..", "escape.txt"))).toBe(false);
  });
});

describe("apply_patch permissions", () => {
  const base = { projectRoot: "/tmp/proj", allowedPaths: [] as string[] };

  it("auto-confirm allows a patch inside the project", () => {
    const rule = checkPermission({ ...base, mode: "auto-confirm" }, "apply_patch", {
      patch: "*** Begin Patch\n*** Add File: /tmp/proj/a.txt\n+x\n*** End Patch",
    });
    expect(rule.verdict).toBe("allow");
  });

  it("asks for a path outside the project even in full-auto", () => {
    const rule = checkPermission({ ...base, mode: "full-auto" }, "apply_patch", {
      patch: "*** Begin Patch\n*** Add File: /etc/elsewhere.txt\n+x\n*** End Patch",
    });
    expect(rule.verdict).not.toBe("allow");
  });

  it("denies sensitive paths inside a patch", () => {
    const rule = checkPermission({ ...base, mode: "full-auto" }, "apply_patch", {
      patch: `*** Begin Patch\n*** Update File: ${os.homedir()}/.ssh/id_rsa\n-a\n+b\n*** End Patch`,
    });
    expect(rule.verdict).toBe("deny");
  });

  it("multi_edit gets the same path checks as edit_file", () => {
    const rule = checkPermission({ ...base, mode: "full-auto" }, "multi_edit", { path: `${os.homedir()}/.ssh/id_rsa`, edits: [] });
    expect(rule.verdict).toBe("deny");
  });
});
