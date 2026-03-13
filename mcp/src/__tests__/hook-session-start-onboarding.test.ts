import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { getSessionStartOnboardingNotice, getUntrackedProjectNotice } from "../cli-hooks-session.js";

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
    expect(notice).toContain("Ask the user whether they want to add it to cortex now.");
    expect(notice).toContain("ownership=\"cortex-managed\"|\"detached\"|\"repo-managed\"");
    expect(notice).toContain("run `npx cortex add`");
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
    expect(notice).toContain("Ask the user whether they want to add it to cortex now.");
  });

  it("still prompts when a same-name tracked project points at a different source path", () => {
    fs.appendFileSync(path.join(cortexPath, "profiles", "personal.yaml"), "  - repo\n");
    const trackedDir = path.join(cortexPath, "repo");
    const otherRepoDir = path.join(tmp.path, "other-repo");
    fs.mkdirSync(trackedDir, { recursive: true });
    fs.mkdirSync(otherRepoDir, { recursive: true });
    fs.writeFileSync(
      path.join(trackedDir, "cortex.project.yaml"),
      `ownership: detached\nsourcePath: ${otherRepoDir}\n`,
    );

    const notice = getUntrackedProjectNotice(cortexPath, repoDir);
    expect(notice).toContain("Ask the user whether they want to add it to cortex now.");
  });

  it("detects the repo root when the session starts in a subdirectory", () => {
    const nestedDir = path.join(repoDir, "src", "feature");
    fs.mkdirSync(nestedDir, { recursive: true });

    const notice = getUntrackedProjectNotice(cortexPath, nestedDir);
    expect(notice).toContain("Ask the user whether they want to add it to cortex now.");
  });

  it("returns a first-run onboarding notice when no projects are tracked yet", () => {
    const emptyProfile = path.join(cortexPath, "profiles", "personal.yaml");
    fs.writeFileSync(emptyProfile, "name: personal\nprojects:\n  - global\n");
    const outsideDir = path.join(tmp.path, "outside");
    fs.mkdirSync(outsideDir, { recursive: true });

    const notice = getSessionStartOnboardingNotice(cortexPath, outsideDir, null);
    expect(notice).toContain("no tracked projects are active");
    expect(notice).toContain("npx cortex add");
  });

  it("returns a project-seeding notice when a tracked project has no findings/tasks yet", () => {
    fs.appendFileSync(path.join(cortexPath, "profiles", "personal.yaml"), "  - repo\n");
    const trackedProjectDir = path.join(cortexPath, "repo");
    fs.mkdirSync(trackedProjectDir, { recursive: true });
    fs.writeFileSync(path.join(trackedProjectDir, "FINDINGS.md"), "# repo FINDINGS\n\n");
    fs.writeFileSync(path.join(trackedProjectDir, "tasks.md"), "# repo tasks\n\n## Active\n\n## Queue\n\n## Done\n");

    const notice = getSessionStartOnboardingNotice(cortexPath, repoDir, "repo");
    expect(notice).toContain("project \"repo\" is tracked but memory is still empty");
    expect(notice).toContain("add_finding");
    expect(notice).toContain("add_task");
  });

  it("returns null for tracked projects after memory is captured", () => {
    fs.appendFileSync(path.join(cortexPath, "profiles", "personal.yaml"), "  - repo\n");
    const trackedProjectDir = path.join(cortexPath, "repo");
    fs.mkdirSync(trackedProjectDir, { recursive: true });
    fs.writeFileSync(path.join(trackedProjectDir, "FINDINGS.md"), "# repo FINDINGS\n\n- [2026-03-12] Captured first finding\n");
    fs.writeFileSync(path.join(trackedProjectDir, "tasks.md"), "# repo tasks\n\n## Active\n\n- [ ] Ship onboarding polish\n\n## Queue\n\n## Done\n");

    expect(getSessionStartOnboardingNotice(cortexPath, repoDir, "repo")).toBeNull();
  });

  it("returns null once the onboarding marker has already been written", () => {
    const sessionsDir = path.join(cortexPath, ".sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "session-start-onboarding-v1"), "seen\n");

    expect(getSessionStartOnboardingNotice(cortexPath, repoDir, null)).toBeNull();
  });
});
