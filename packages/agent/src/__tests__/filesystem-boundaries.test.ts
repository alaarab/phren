import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Isolate cwd and put a real process timeout around regex execution: an
// accidental synchronous infinite loop cannot be stopped by a test timer.
const grepModule = new URL("../tools/grep.ts", import.meta.url).href;
const writeModule = new URL("../tools/write-file.ts", import.meta.url).href;
const loader = import.meta.resolve("tsx");
let directory: string, project: string;
function run(script: string): any {
  const source = `const { grepTool } = await import(${JSON.stringify(grepModule)});
    const { writeFileTool } = await import(${JSON.stringify(writeModule)});
    ${script}`;
  return JSON.parse(execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e", source], {
    cwd: project, timeout: 5_000, encoding: "utf8",
  }));
}
beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-boundaries-")));
  project = path.join(directory, "project");
  fs.mkdirSync(project);
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("filesystem tool boundaries", () => {
  it("terminates multiline anchors, lookarounds and empty matches across files", () => {
    fs.writeFileSync(path.join(project, "one.txt"), "a\nb");
    fs.writeFileSync(path.join(project, "two.txt"), "a\nb");
    const result = run(`const output = [];
      for (const pattern of ["^", "$", "(?=.)", "(?:)", "a\\nb"]) {
        output.push(await grepTool.execute({ path: "one.txt", pattern, multiline: true, output_mode: "count" }));
      }
      output.push(await grepTool.execute({ path: ".", pattern: "(?:)", multiline: true, output_mode: "count" }));
      console.log(JSON.stringify(output));`);
    expect(result.slice(0, 5).map((item: { output: string }) => item.output)).toEqual(["1", "1", "3", "4", "1"]);
    expect(result[5].output).toContain("one.txt: 4");
    expect(result[5].output).toContain("two.txt: 4");
  });

  it("directory search excludes outside symlinks and sensitive files and aliases", () => {
    fs.writeFileSync(path.join(project, "public.txt"), "fixture_public");
    fs.writeFileSync(path.join(project, "secrets.json"), "fixture_secret");
    fs.writeFileSync(path.join(directory, "outside.txt"), "fixture_outside");
    fs.symlinkSync(path.join(directory, "outside.txt"), path.join(project, "escape.txt"));
    fs.symlinkSync(path.join(project, "secrets.json"), path.join(project, "alias.txt"));
    const result = run(`console.log(JSON.stringify(await grepTool.execute({ path: ".", pattern: "fixture_" })));`);
    expect(result.output).toContain("fixture_public");
    expect(result.output).not.toContain("fixture_secret");
    expect(result.output).not.toContain("fixture_outside");
    const direct = run(`console.log(JSON.stringify(await grepTool.execute({ path: "alias.txt", pattern: "fixture_" })));`);
    expect(direct.is_error).toBe(true);
    expect(direct.output).not.toContain("fixture_secret");
  });

  it("write_file refuses a missing destination through an escaping parent link", () => {
    const outside = path.join(directory, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(project, "escape"), "dir");
    const result = run(`console.log(JSON.stringify(await writeFileTool.execute({ path: "escape/new/file.txt", content: "fixture_write" })));`);
    expect(result.is_error).toBe(true);
    expect(fs.existsSync(path.join(outside, "new"))).toBe(false);
    const traversal = run(`console.log(JSON.stringify(await writeFileTool.execute({ path: "escape/../new.txt", content: "fixture_write" })));`);
    expect(traversal.is_error).toBe(true);
    expect(fs.existsSync(path.join(directory, "new.txt"))).toBe(false);
    const valid = run(`console.log(JSON.stringify(await writeFileTool.execute({ path: "new/file.txt", content: "fixture_write" })));`);
    expect(valid.is_error).toBeUndefined();
    expect(fs.readFileSync(path.join(project, "new/file.txt"), "utf8")).toBe("fixture_write");
  });
});
