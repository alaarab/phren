import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { getUntrackedProjectNotice } from "../cli-hooks-session.js";

describe("hook session start onboarding notice", () => {
  let tmp: { path: string; cleanup: () => void };
  let cortexPath: string;
  let repoDir: string;
  let originalProfile: string | undefined;

  beforeEach(() => {
    tmp = makeTempDir("hook-session-onboarding-");
    cortexPath = path.join(tmp.path, ".cortex");
    repoDir = path.join(tmp.path, "repo");
    originalProfile = process.env.CORTEX_PROFILE;
    fs.mkdirSync(path.join(cortexPath, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(cortexPath, "profiles", "personal.yaml"), "name: personal\nprojects:\n  - global\n");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  });

  afterEach(() => {
    if (originalProfile === undefined) delete process.env.CORTEX_PROFILE;
    else process.env.CORTEX_PROFILE = originalProfile;
    tmp.cleanup();
  });

  it("returns an ask-first notice for untracked repos", () => {
    const notice = getUntrackedProjectNotice(cortexPath, repoDir);
    expect(notice).toContain("Ask the user whether they want to add it to cortex.");
    expect(notice).toContain("`add_project` MCP tool with path=");
    expect(notice).toContain("run `cortex add`");
  });

  it("returns null once the project is already tracked", () => {
    fs.appendFileSync(path.join(cortexPath, "profiles", "personal.yaml"), "  - repo\n");
    expect(getUntrackedProjectNotice(cortexPath, repoDir)).toBeNull();
  });

  it("still prompts when the project exists outside the active profile", () => {
    process.env.CORTEX_PROFILE = "work";
    fs.writeFileSync(path.join(cortexPath, "profiles", "work.yaml"), "name: work\nprojects:\n  - global\n");
    fs.mkdirSync(path.join(cortexPath, "repo"), { recursive: true });

    const notice = getUntrackedProjectNotice(cortexPath, repoDir);
    expect(notice).toContain("Ask the user whether they want to add it to cortex.");
  });

  it("detects the repo root when the session starts in a subdirectory", () => {
    const nestedDir = path.join(repoDir, "src", "feature");
    fs.mkdirSync(nestedDir, { recursive: true });

    const notice = getUntrackedProjectNotice(cortexPath, nestedDir);
    expect(notice).toContain("Ask the user whether they want to add it to cortex.");
  });
});
