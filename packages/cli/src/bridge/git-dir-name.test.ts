import { expect, it } from "vitest";
import { isGitDirName } from "./git-dir-name.js";

it("knows every spelling some volume resolves to .git, and nothing else", () => {
  for (const name of [".git", ".GIT", ".Git", "GIT~1", "git~1", ".git.", ".git ", ".git. .", ".g‌it", "﻿.git"]) {
    expect(isGitDirName(name), JSON.stringify(name)).toBe(true);
  }
  for (const name of [".github", ".gitignore", ".gitattributes", "git", ".git2", "x.git", "git~2", ".", "..", ""]) {
    expect(isGitDirName(name), JSON.stringify(name)).toBe(false);
  }
});
