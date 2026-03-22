import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";
import { getUntrackedProjectNotice } from "./cli/hooks-session.js";
import { writeProjectConfig } from "./project-config.js";

describe("getUntrackedProjectNotice", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) cleanup();
    }
  });

  it("returns a notice for an untracked repository", () => {
    const tmp = makeTempDir("phren-sessionstart-untracked-");
    cleanups.push(tmp.cleanup);
    const phrenPath = path.join(tmp.path, "phren");
    const repoDir = path.join(tmp.path, "untracked-repo");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });

    const notice = getUntrackedProjectNotice(phrenPath, path.join(repoDir, "src"));
    expect(notice).toContain("not tracked by phren yet");
    expect(notice).toContain(`npx phren add \"${repoDir}\"`);
    expect(notice).toContain(`path="${repoDir}"`);
    expect(notice).toContain("add_project");
  });

  it("does not show a notice when a project is tracked by sourcePath", () => {
    const tmp = makeTempDir("phren-sessionstart-sourcepath-");
    cleanups.push(tmp.cleanup);
    const phrenPath = path.join(tmp.path, "phren");
    const repoDir = path.join(tmp.path, "actual-repo");
    const trackedProjectName = "custom-project-name";
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(phrenPath, trackedProjectName), { recursive: true });
    writeProjectConfig(phrenPath, trackedProjectName, { sourcePath: repoDir });

    const notice = getUntrackedProjectNotice(phrenPath, repoDir);
    expect(notice).toBeNull();
  });

  it("does not show a notice for legacy tracked projects matched by name", () => {
    const tmp = makeTempDir("phren-sessionstart-legacy-");
    cleanups.push(tmp.cleanup);
    const phrenPath = path.join(tmp.path, "phren");
    const repoDir = path.join(tmp.path, "legacy-project");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(phrenPath, "legacy-project"), { recursive: true });

    const notice = getUntrackedProjectNotice(phrenPath, repoDir);
    expect(notice).toBeNull();
  });
});
