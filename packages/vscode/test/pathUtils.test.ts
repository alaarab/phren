import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { baseName, containingFolder, isWindowsPath, relativeInside, samePath } from "../src/pathUtils";
import { buildCitation, workspaceFolderPath } from "../src/commands/editor-commands";
import { TreeDataSource } from "../src/providers/tree-data";
import { fakeClient } from "./test-helpers";

describe("pathUtils", () => {
  it("recognises drive-letter, UNC and WSL paths as Windows paths, and POSIX paths as not", () => {
    expect(isWindowsPath("C:\\repo\\a.ts")).toBe(true);
    expect(isWindowsPath("c:/repo/a.ts")).toBe(true);
    expect(isWindowsPath("\\\\wsl$\\Ubuntu\\home\\me")).toBe(true);
    expect(isWindowsPath("\\\\wsl.localhost\\Ubuntu\\home\\me")).toBe(true);
    expect(isWindowsPath("/home/me/my repo")).toBe(false);
  });

  it("relativeInside returns forward-slash paths for drive letters with spaces", () => {
    expect(relativeInside("C:\\My Repo", "C:\\My Repo\\src\\a b.ts")).toBe("src/a b.ts");
  });

  it("relativeInside ignores drive-letter case and separator style", () => {
    expect(relativeInside("c:\\repo", "C:/Repo/src/a.ts")).toBe("src/a.ts");
  });

  it("relativeInside handles wsl$ and wsl.localhost UNC roots", () => {
    expect(relativeInside("\\\\wsl$\\Ubuntu\\home\\me\\app", "\\\\wsl$\\Ubuntu\\home\\me\\app\\src\\a.ts")).toBe("src/a.ts");
    expect(
      relativeInside("\\\\wsl.localhost\\Ubuntu\\home\\me\\app", "\\\\wsl.localhost\\Ubuntu\\home\\me\\app\\a.ts"),
    ).toBe("a.ts");
  });

  it("relativeInside rejects a different drive, a different UNC distro, a sibling and the folder itself", () => {
    expect(relativeInside("C:\\repo", "D:\\repo\\a.ts")).toBeUndefined();
    expect(relativeInside("\\\\wsl$\\Ubuntu\\app", "\\\\wsl$\\Debian\\app\\a.ts")).toBeUndefined();
    expect(relativeInside("/repo", "/repo2/a.ts")).toBeUndefined();
    expect(relativeInside("/repo", "/repo")).toBeUndefined();
  });

  it("relativeInside keeps a file whose name merely starts with two dots", () => {
    expect(relativeInside("/repo", "/repo/..notes/a.md")).toBe("..notes/a.md");
  });

  it("containingFolder picks the deepest of nested folders", () => {
    expect(containingFolder(["/mono", "/mono/pkg"], "/mono/pkg/a.ts")).toBe("/mono/pkg");
    expect(containingFolder(["/mono/pkg", "/mono"], "/mono/pkg/a.ts")).toBe("/mono/pkg");
    expect(containingFolder(["/a", "/b"], "/c/x.ts")).toBeUndefined();
    expect(containingFolder([], "/c/x.ts")).toBeUndefined();
  });

  it("samePath ignores trailing separators, slash style and Windows case", () => {
    expect(samePath("C:\\Repo\\", "c:/repo")).toBe(true);
    expect(samePath("/a/b/", "/a/b")).toBe(true);
    expect(samePath("/a/B", "/a/b")).toBe(false);
    expect(samePath("", "")).toBe(false);
  });

  it("baseName reads either separator", () => {
    expect(baseName("C:\\Users\\me\\My App\\")).toBe("My App");
    expect(baseName("/x/y")).toBe("y");
  });
});

describe("buildCitation with Windows paths", () => {
  it("cites a repo-relative file with forward slashes on a drive-letter folder", () => {
    expect(buildCitation({ fsPath: "C:\\My Repo\\src\\a.ts" }, { start: { line: 4 } }, "c:\\my repo")).toEqual({
      file: "src/a.ts",
      line: 5,
      repo: "c:\\my repo",
    });
  });

  it("cites a WSL UNC file relative to its UNC workspace folder", () => {
    const folder = "\\\\wsl.localhost\\Ubuntu\\home\\me\\app";
    expect(buildCitation({ fsPath: `${folder}\\lib\\x.py` }, { start: { line: 0 } }, folder)).toEqual({
      file: "lib/x.py",
      line: 1,
      repo: folder,
    });
  });

  it("cites by absolute path when the file is on another drive", () => {
    expect(buildCitation({ fsPath: "D:\\other\\a.ts" }, { start: { line: 0 } }, "C:\\repo")).toEqual({
      file: "D:\\other\\a.ts",
      line: 1,
    });
  });
});

describe("workspaceFolderPath in a multi-root workspace", () => {
  const doc = (p: string) => ({ uri: { fsPath: p, scheme: "file" } }) as unknown as vscode.TextDocument;

  beforeEach(() => {
    vscode.workspace.workspaceFolders = undefined;
  });

  it("returns undefined when no folder is open", () => {
    expect(workspaceFolderPath(doc("/x/a.ts"))).toBeUndefined();
  });

  it("returns the deepest folder when one workspace folder nests inside another", () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "/mono" } }, { uri: { fsPath: "/mono/pkg" } }];
    expect(workspaceFolderPath(doc("/mono/pkg/a.ts"))).toBe("/mono/pkg");
  });

  it("finds a Windows folder from a differently-cased document path", () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "c:\\work\\app" } }];
    expect(workspaceFolderPath(doc("C:\\Work\\App\\a.ts"))).toBe("c:\\work\\app");
  });
});

describe("TreeDataSource.detectActiveProject across workspace folders", () => {
  const projects = [
    { name: "alpha", source: "/w/alpha" },
    { name: "beta", source: "C:\\Work\\Beta" },
  ];
  const source = () => new TreeDataSource(fakeClient(), "/store");

  it("matches a project through a later workspace folder, not only the first", () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "/w/other" } }, { uri: { fsPath: "/w/alpha" } }];
    expect(source().detectActiveProject(projects)).toBe("alpha");
  });

  it("matches a Windows source regardless of drive-letter case and trailing slash", () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "c:\\work\\beta\\" } }];
    expect(source().detectActiveProject(projects)).toBe("beta");
  });

  it("falls back to the folder name for a Windows path (backslashes)", () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "D:\\code\\Alpha" } }];
    expect(source().detectActiveProject(projects)).toBe("alpha");
  });

  it("returns undefined with no workspace folder", () => {
    vscode.workspace.workspaceFolders = undefined;
    expect(source().detectActiveProject(projects)).toBeUndefined();
  });
});
