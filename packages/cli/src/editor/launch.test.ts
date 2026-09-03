/**
 * `$EDITOR` is a command line, not a binary path. The old helper passed it
 * straight to execFileSync, which fails with ENOENT for any editor carrying
 * arguments — `code --wait`, `nvim -u NONE`, `omarchy-launch-editor --inline`.
 */

import { describe, expect, it } from "vitest";
import { resolveEditorCommand, splitCommandLine } from "./launch.js";

describe("splitCommandLine", () => {
  it("splits on whitespace", () => {
    expect(splitCommandLine("nvim")).toEqual(["nvim"]);
    expect(splitCommandLine("code --wait")).toEqual(["code", "--wait"]);
    expect(splitCommandLine("  nvim   -u   NONE  ")).toEqual(["nvim", "-u", "NONE"]);
  });

  it("keeps a quoted path with spaces in one piece", () => {
    expect(splitCommandLine('"/Applications/My Editor" --wait')).toEqual(["/Applications/My Editor", "--wait"]);
    expect(splitCommandLine("'/opt/my editor/bin' -f")).toEqual(["/opt/my editor/bin", "-f"]);
  });

  it("keeps an empty quoted argument, which is not the same as no argument", () => {
    expect(splitCommandLine('editor "" x')).toEqual(["editor", "", "x"]);
  });

  it("returns nothing for empty input", () => {
    expect(splitCommandLine("")).toEqual([]);
    expect(splitCommandLine("   ")).toEqual([]);
  });
});

describe("resolveEditorCommand", () => {
  it("handles an editor with arguments — the case that was broken", () => {
    expect(resolveEditorCommand({ EDITOR: "omarchy-launch-editor --inline" }))
      .toEqual({ command: "omarchy-launch-editor", args: ["--inline"] });
    expect(resolveEditorCommand({ EDITOR: "code --wait" }))
      .toEqual({ command: "code", args: ["--wait"] });
  });

  it("handles a bare binary", () => {
    expect(resolveEditorCommand({ EDITOR: "nvim" })).toEqual({ command: "nvim", args: [] });
  });

  it("prefers EDITOR over VISUAL", () => {
    expect(resolveEditorCommand({ EDITOR: "nvim", VISUAL: "emacs" })?.command).toBe("nvim");
    expect(resolveEditorCommand({ VISUAL: "emacs" })?.command).toBe("emacs");
  });

  it("falls back to vi when nothing is set or the value is blank", () => {
    expect(resolveEditorCommand({})).toEqual({ command: "vi", args: [] });
    expect(resolveEditorCommand({ EDITOR: "   " })).toEqual({ command: "vi", args: [] });
  });
});
