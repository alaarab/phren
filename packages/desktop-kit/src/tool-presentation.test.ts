import { describe, expect, it } from "vitest";
import { ToolPresentation, SyntaxTokenizer, toolOutputPreview, diffDocument, DiffWords } from "./tool-presentation.js";

const json = (value: unknown): string => JSON.stringify(value);

describe("ToolPresentationTests", () => {
  it("writeBecomesANewFilePatchNamedByItsShortPath", () => {
    const write = ToolPresentation.of("Write", json({ file_path: "/Users/me/app/Sources/Theme.swift", content: "import SwiftUI\nlet accent = purple" }));
    expect(write.title).toBe("Patch");
    expect(write.patch).toBe("*** Add File: /Users/me/app/Sources/Theme.swift\n+import SwiftUI\n+let accent = purple");
    expect(write.preview).toBe("Sources/Theme.swift");
    const document = diffDocument(write.patch as string);
    expect(document.added).toBe(2); expect(document.removed).toBe(0);
    expect(document.rows[0].text).toBe("New file · /Users/me/app/Sources/Theme.swift");
    expect(document.rows[document.rows.length - 1].new).toBe(2);
  });

  it("multiEditBecomesOneHunkPerEdit", () => {
    const edit = ToolPresentation.of("MultiEdit", json({
      file_path: "/app/Theme.swift",
      edits: [
        { old_string: "let a = 1", new_string: "let a = 2" },
        { old_string: "let b = 1\nlet c = 1", new_string: "let b = 3" },
      ],
    }));
    expect(edit.title).toBe("Patch");
    expect(edit.patch).toBe("*** Update File: /app/Theme.swift\n@@\n-let a = 1\n+let a = 2\n@@\n-let b = 1\n-let c = 1\n+let b = 3");
    const document = diffDocument(edit.patch as string);
    expect(document.changeStarts.length).toBe(2);
    expect(document.added).toBe(2); expect(document.removed).toBe(3);
  });

  it("notebookAndStringReplaceHaveInputFallbackPatches", () => {
    const notebook = ToolPresentation.of("NotebookEdit", json({ notebook_path: "work.ipynb", new_source: "print(1)" }));
    expect(notebook.path).toBe("work.ipynb");
    expect(notebook.patch?.includes("+print(1)")).toBe(true);
    const replace = ToolPresentation.of("str_replace_editor", json({ path: "main.py", old_str: "a = 1", new_str: "a = 2" }));
    expect(replace.patch?.includes("-a = 1\n+a = 2")).toBe(true);
    const patch = ToolPresentation.of("apply_patch", "*** Begin Patch\n*** Update File: main.py\n@@\n-old\n+new\n*** End Patch");
    expect(patch.path).toBe("main.py");
    expect(patch.patch).not.toBeNull();
  });

  it("claudeCodeReadsSearchesAndTodosSummarize", () => {
    const read = ToolPresentation.of("Read", json({ file_path: "/app/Sources/Theme.swift", offset: 10, limit: 40 }));
    expect(read.title).toBe("Read");
    expect(read.preview).toBe("Sources/Theme.swift · lines 10–49");
    expect(read.patch).toBeNull();
    const grep = ToolPresentation.of("Grep", json({ pattern: "accent", path: "/app/Sources" }));
    expect(grep.title).toBe("Grep"); expect(grep.preview).toBe("accent in app/Sources");
    expect(ToolPresentation.of("Glob", json({ pattern: "**/*.swift" })).preview).toBe("**/*.swift");
    for (const name of ["grep", "glob", "rg"])
      expect(ToolPresentation.of(name, json({ pattern: "accent", path: "/app/Sources" })).preview).toBe("accent in app/Sources");
    const fetch = ToolPresentation.of("WebFetch", json({ url: "https://example.com/doc", prompt: "summarize" }));
    expect(fetch.title).toBe("Fetch"); expect(fetch.preview).toBe("https://example.com/doc");
    const todos = ToolPresentation.of("TodoWrite", json({ todos: [
      { content: "Ship it", status: "completed" },
      { content: "Test it", status: "in_progress" },
      { content: "Doc it", status: "pending" },
    ] }));
    expect(todos.title).toBe("Todos"); expect(todos.body).toBe("☑ Ship it\n◐ Test it\n☐ Doc it");
    const agent = ToolPresentation.of("Task", json({ description: "Audit the sync loop", prompt: "Long prompt…" }));
    expect(agent.title).toBe("Agent"); expect(agent.preview).toBe("Audit the sync loop");
  });

  it("copilotViewAndOpenCodeReadAreFileReads", () => {
    const view = ToolPresentation.of("view", json({ path: "/home/me/hub/scripts/coverage-delta.mjs", view_range: [10, 40] }));
    expect(view.title).toBe("View");
    expect(view.body).toBe("/home/me/hub/scripts/coverage-delta.mjs · lines 10–40");
    expect(view.path).toBe("/home/me/hub/scripts/coverage-delta.mjs");
    expect(view.outputLanguage).toBe(SyntaxTokenizer.Language.JAVASCRIPT);
    expect(view.body.includes("\\/")).toBe(false);
    const read = ToolPresentation.of("read", json({ filePath: "/app/Theme.swift", offset: 5, limit: 10 }));
    expect(read.body).toBe("/app/Theme.swift · lines 5–14");
    expect(read.outputLanguage).toBe(SyntaxTokenizer.Language.SWIFT);
    expect(ToolPresentation.of("Bash", json({ command: "cat a.swift" })).outputLanguage).toBe(SyntaxTokenizer.Language.PLAIN);
    expect(ToolPresentation.of("custom", json({ where: "/a/b" })).body).toBe("{\n  \"where\" : \"/a/b\"\n}");
  });

  it("shellPreviewUsesTheCallsDescription", () => {
    const described = ToolPresentation.of("Bash", json({ command: "cd ~/Projects/phren && sed -n 955,982p bridge.test.ts", description: "Reading the failing test" }));
    expect(described.title).toBe("Shell"); expect(described.preview).toBe("Reading the failing test");
    expect(described.body).toBe("cd ~/Projects/phren && sed -n 955,982p bridge.test.ts");
    expect(ToolPresentation.of("Bash", json({ command: "swift build" })).preview).toBe("swift build");
  });

  it("unknownJSONInputNeverPreviewsABareBrace", () => {
    expect(ToolPresentation.of("SendMessage", json({ to: "researcher", summary: "Check the build", message: "Long body…" })).preview).toBe("Check the build");
    expect(ToolPresentation.of("ListAgents", "{}").preview).toBe("");
    const unknown = ToolPresentation.of("Mystery", json({ alpha: "value", beta: 2 }));
    expect(unknown.preview.startsWith("{")).toBe(false);
    expect(unknown.preview.includes("alpha")).toBe(true);
  });

  it("outputPreviewBoundsAreConfigurable", () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    expect(toolOutputPreview(output).text.split("\n").length).toBe(6);
    expect(toolOutputPreview(output, 80, 16_000).text.split("\n").length).toBe(80);
    expect(toolOutputPreview(output, 80, 16_000).text.endsWith("…")).toBe(true);
    expect(toolOutputPreview(output, 200, 16_000).text).toBe(output);
  });

  it("shellEditsNameThePathsTheyTouch", () => {
    const cmd = "python3 - <<'PY'\nfrom pathlib import Path\np=Path('/Users/me/.phren/objectstudio/reference/live-midi')\n(p/'source-inputs.json').write_text('{}')\n" +
      "with (p/'WORK.md').open('a') as f: f.write('x')\nprint('see https://example.org/docs/x', open('/dev/null'))\nPY\ngit diff --check";
    const shell = ToolPresentation.of("exec_command", `{"cmd":${JSON.stringify(cmd)}}`);
    expect(shell.editsFiles).toBe(true);
    expect(shell.editedPaths).toEqual(["/Users/me/.phren/objectstudio/reference/live-midi", "/dev/null"]);
    expect(ToolPresentation.of("Bash", "{\"command\":\"sed -i '' 's/a/b/' ~/work/app/README.md\"}").editedPaths).toEqual(["~/work/app/README.md"]);
    expect(ToolPresentation.of("Bash", "{\"command\":\"touch ./notes/today.md\"}").editsFiles).toBe(true);
    expect(ToolPresentation.of("Bash", "{\"command\":\"touch ./notes/today.md\"}").editedPaths).toEqual(["./notes/today.md"]);
    const read = ToolPresentation.of("Bash", "{\"command\":\"cat /Users/me/.phren/phren/tasks.md | head\"}");
    expect(read.editsFiles).toBe(false); expect(read.editedPaths).toEqual([]);
  });
});

describe("DiffDocumentTests", () => {
  it("changesRowsDrawEachSignOnce", () => {
    const document = diffDocument("@@ -1,3 +1,3 @@\n keep\n-let accent = green\n+let accent = purple");
    expect(document.rows.map((r) => r.display)).toEqual(["@@ -1,3 +1,3 @@", " keep", "−let accent = green", "+let accent = purple"]);
  });

  it("blankContextLinesKeepLineNumbersAndNoNewlineMarkerIsNotARow", () => {
    const document = diffDocument("@@ -1,4 +1,4 @@\n one\n\n-three\n\\ No newline at end of file\n+tres\n\\ No newline at end of file\n");
    expect(document.rows.map((r) => r.kind)).toEqual(["hunk", "context", "context", "removed", "added"]);
    expect(document.rows.map((r) => r.old)).toEqual([null, 1, 2, 3, null]);
    expect(document.rows.map((r) => r.new)).toEqual([null, 1, 2, null, 3]);
    expect(document.rows[2].display).toBe(" ");
  });
});

describe("DiffWordsTests", () => {
  it("highlightsOnlyTheChangedWordRuns", () => {
    const cases: { old: string; new: string; oldRuns: string[]; newRuns: string[]; matched: number }[] = [
      { old: "let accent = green", new: "let accent = purple", oldRuns: ["green"], newRuns: ["purple"], matched: 3 },
      { old: "alpha", new: "beta", oldRuns: ["alpha"], newRuns: ["beta"], matched: 0 },
      { old: "let a = 1 + 2", new: "let b = 1 + 3", oldRuns: ["a", "2"], newRuns: ["b", "3"], matched: 4 },
      { old: "let x = 1", new: "let x =  1", oldRuns: [], newRuns: [], matched: 4 },
      { old: "keep alpha beta end", new: "keep gamma delta end", oldRuns: ["alpha beta"], newRuns: ["gamma delta"], matched: 2 },
    ];
    for (const c of cases) {
      const highlight = DiffWords.highlight(c.old, c.new);
      expect(highlight.old.map((r) => c.old.slice(r.start, r.end))).toEqual(c.oldRuns);
      expect(highlight.new.map((r) => c.new.slice(r.start, r.end))).toEqual(c.newRuns);
      expect(highlight.matched).toBe(c.matched);
    }
  });
});
