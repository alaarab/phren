import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { editFileTool, multiEditTool } from "../tools/edit-file.js";
import { readFileTool } from "../tools/read-file.js";
import { writeFileTool } from "../tools/write-file.js";
import { applyPatchTool } from "../tools/apply-patch.js";
import { resetFileState } from "../tools/file-state.js";

/** Change a file the way the user or a formatter would, with a later mtime. */
function changeOnDisk(file: string, content: string): void {
  fs.writeFileSync(file, content);
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(file, later, later);
}

describe("stale-file and read-before-write guard", () => {
  let dir: string;
  const cwd = process.cwd();

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-state-")));
    process.chdir(dir);
    resetFileState();
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.PHREN_AGENT_FILE_GUARD;
  });

  it("write_file creates a new file without a read", async () => {
    const r = await writeFileTool.execute({ path: "new.txt", content: "hi\n" });
    expect(r.is_error).toBeFalsy();
    expect(fs.readFileSync("new.txt", "utf-8")).toBe("hi\n");
  });

  it("write_file refuses to overwrite an existing file it never read", async () => {
    fs.writeFileSync("a.txt", "keep me\n");
    const r = await writeFileTool.execute({ path: "a.txt", content: "clobbered\n" });
    expect(r.is_error).toBe(true);
    expect(r.output).toContain("has not been read");
    expect(fs.readFileSync("a.txt", "utf-8")).toBe("keep me\n");

    await readFileTool.execute({ path: "a.txt" });
    const again = await writeFileTool.execute({ path: "a.txt", content: "rewritten\n" });
    expect(again.is_error).toBeFalsy();
    expect(fs.readFileSync("a.txt", "utf-8")).toBe("rewritten\n");
  });

  it("a partial read counts as a read", async () => {
    fs.writeFileSync("a.txt", "1\n2\n3\n");
    await readFileTool.execute({ path: "a.txt", offset: 2, limit: 1 });
    const r = await writeFileTool.execute({ path: "a.txt", content: "x\n" });
    expect(r.is_error).toBeFalsy();
  });

  it("edit_file works on a file it never read: old_string grounds it", async () => {
    fs.writeFileSync("a.txt", "alpha\nbeta\n");
    const r = await editFileTool.execute({ path: "a.txt", old_string: "beta", new_string: "gamma" });
    expect(r.is_error).toBeFalsy();
    expect(fs.readFileSync("a.txt", "utf-8")).toBe("alpha\ngamma\n");
  });

  it("refuses edit_file, multi_edit and write_file on a file changed since the read", async () => {
    fs.writeFileSync("a.txt", "alpha\nbeta\n");
    await readFileTool.execute({ path: "a.txt" });
    changeOnDisk("a.txt", "alpha\nbeta\nuser line\n");

    const edit = await editFileTool.execute({ path: "a.txt", old_string: "beta", new_string: "gamma" });
    expect(edit.is_error).toBe(true);
    expect(edit.output).toContain("changed on disk");
    const multi = await multiEditTool.execute({ path: "a.txt", edits: [{ old_string: "beta", new_string: "gamma" }] });
    expect(multi.is_error).toBe(true);
    const write = await writeFileTool.execute({ path: "a.txt", content: "alpha\ngamma\n" });
    expect(write.is_error).toBe(true);
    expect(fs.readFileSync("a.txt", "utf-8")).toBe("alpha\nbeta\nuser line\n");

    // Reading it again clears the way, and the user's line survives.
    await readFileTool.execute({ path: "a.txt" });
    const retry = await editFileTool.execute({ path: "a.txt", old_string: "beta", new_string: "gamma" });
    expect(retry.is_error).toBeFalsy();
    expect(fs.readFileSync("a.txt", "utf-8")).toBe("alpha\ngamma\nuser line\n");
  });

  it("the agent's own edits keep its picture current", async () => {
    fs.writeFileSync("a.txt", "one\ntwo\n");
    await readFileTool.execute({ path: "a.txt" });
    expect((await editFileTool.execute({ path: "a.txt", old_string: "one", new_string: "1" })).is_error).toBeFalsy();
    expect((await editFileTool.execute({ path: "a.txt", old_string: "two", new_string: "2" })).is_error).toBeFalsy();
    expect((await writeFileTool.execute({ path: "a.txt", content: "done\n" })).is_error).toBeFalsy();
    expect((await writeFileTool.execute({ path: "a.txt", content: "done again\n" })).is_error).toBeFalsy();
  });

  it("a touch that leaves the content alone is not a change", async () => {
    fs.writeFileSync("a.txt", "same\n");
    await readFileTool.execute({ path: "a.txt" });
    changeOnDisk("a.txt", "same\n");
    const r = await editFileTool.execute({ path: "a.txt", old_string: "same", new_string: "new" });
    expect(r.is_error).toBeFalsy();
  });

  it("apply_patch refuses a stale update and an Add File over an unread file, writing nothing", async () => {
    fs.writeFileSync("a.txt", "x\ny\n");
    fs.writeFileSync("b.txt", "existing\n");
    await readFileTool.execute({ path: "a.txt" });
    changeOnDisk("a.txt", "x\ny\nz\n");

    const stale = await applyPatchTool.execute({
      patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n x\n-y\n+Y\n*** End Patch",
    });
    expect(stale.is_error).toBe(true);
    expect(stale.output).toContain("changed on disk");
    expect(fs.readFileSync("a.txt", "utf-8")).toBe("x\ny\nz\n");

    const overwrite = await applyPatchTool.execute({
      patch: "*** Begin Patch\n*** Add File: b.txt\n+replaced\n*** End Patch",
    });
    expect(overwrite.is_error).toBe(true);
    expect(overwrite.output).toContain("has not been read");
    expect(fs.readFileSync("b.txt", "utf-8")).toBe("existing\n");

    // A patch's own result counts as seen: a second hunk on the same file applies.
    await readFileTool.execute({ path: "a.txt" });
    const first = await applyPatchTool.execute({ patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n x\n-y\n+Y\n*** End Patch" });
    expect(first.is_error).toBeFalsy();
    const second = await applyPatchTool.execute({ patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n Y\n-z\n+Z\n*** End Patch" });
    expect(second.is_error).toBeFalsy();
    expect(fs.readFileSync("a.txt", "utf-8")).toBe("x\nY\nZ\n");
  });

  it("PHREN_AGENT_FILE_GUARD=off turns the guard off", async () => {
    process.env.PHREN_AGENT_FILE_GUARD = "off";
    fs.writeFileSync("a.txt", "keep me\n");
    const r = await writeFileTool.execute({ path: "a.txt", content: "clobbered\n" });
    expect(r.is_error).toBeFalsy();
  });
});
