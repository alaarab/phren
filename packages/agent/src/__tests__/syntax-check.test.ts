import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as nodeModule from "module";
import * as os from "os";
import * as path from "path";
import { editFileTool } from "../tools/edit-file.js";
import { writeFileTool } from "../tools/write-file.js";
import { applyPatchTool } from "../tools/apply-patch.js";
import { syntaxCheckNote } from "../tools/syntax-check.js";
import { resetFileState } from "../tools/file-state.js";
import { modelVisibleOutput } from "../agent-loop/stream.js";

const hasStrip = typeof (nodeModule as unknown as { stripTypeScriptTypes?: unknown }).stripTypeScriptTypes === "function";
const hasPython = (() => {
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

describe("syntax check after edits", () => {
  let dir: string;
  const cwd = process.cwd();
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "syntax-check-")));
    process.chdir(dir);
    resetFileState();
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.PHREN_AGENT_SYNTAX_CHECK;
  });

  it.runIf(hasStrip)("edit_file reports a TypeScript file it left unparseable, and is quiet once it parses again", async () => {
    fs.writeFileSync("a.ts", "export function f(x: string): string {\n  return x;\n}\n");
    const broken = await editFileTool.execute({ path: "a.ts", old_string: "f(x: string)", new_string: "f(x: string" });
    expect(broken.is_error).toBeFalsy();
    const visible = modelVisibleOutput(broken.output);
    expect(visible).toContain("Syntax check: the file no longer parses.");
    expect(visible).toContain("a.ts");

    const fixed = await editFileTool.execute({ path: "a.ts", old_string: "f(x: string", new_string: "f(x: string)" });
    expect(fixed.output).not.toContain("Syntax check");
  });

  it.runIf(hasStrip)("doesn't blame an edit for errors the file already had", async () => {
    fs.writeFileSync("a.ts", "export const a = (;\nexport const b = 1;\n");
    const r = await editFileTool.execute({ path: "a.ts", old_string: "b = 1", new_string: "b = 2" });
    expect(r.output).not.toContain("Syntax check");
  });

  it.runIf(hasStrip)("treats enums (parsed, not strippable) and JSX as fine", () => {
    expect(syntaxCheckNote("e.ts", null, "enum E { A }\nexport const x = E.A;\n")).toBeNull();
    expect(syntaxCheckNote("c.js", null, "export const C = () => <div>hi</div>;\n")).toBeNull();
    expect(syntaxCheckNote("c.tsx", null, "export const C = () => <div>{(</div>;\n")).toBeNull();
  });

  it.runIf(hasStrip)("write_file and apply_patch check what they wrote", async () => {
    const write = await writeFileTool.execute({ path: "new.mjs", content: "export const z = () => {\n" });
    expect(write.output).toContain("Syntax check");
    const patch = await applyPatchTool.execute({
      patch: "*** Begin Patch\n*** Add File: b.ts\n+export const b = [1, 2;\n*** End Patch",
    });
    expect(patch.output).toContain("Syntax check");
    expect(patch.output).toContain("b.ts");
  });

  it("JSON: a broken file is reported with its line, JSONC is left alone", () => {
    const note = syntaxCheckNote("a.json", "{\"a\": 1}\n", "{\n  \"a\": 1,\n}\n");
    expect(note).toMatch(/a\.json:\d+:\d+/);
    expect(syntaxCheckNote("tsconfig.json", null, "{\n  // comment\n  \"a\": 1,\n}\n")).toBeNull();
  });

  it.runIf(hasPython)("Python: a broken file is reported with its line", () => {
    const note = syntaxCheckNote("a.py", "def f():\n    return 1\n", "def f(:\n    return 1\n");
    expect(note).toContain("a.py:1:");
  });

  it("PHREN_AGENT_SYNTAX_CHECK=off turns it off", () => {
    process.env.PHREN_AGENT_SYNTAX_CHECK = "off";
    expect(syntaxCheckNote("a.json", null, "{")).toBeNull();
  });
});
