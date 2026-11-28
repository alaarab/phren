import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveTaskItem,
  readReviewQueue,
  readReviewQueueAcrossProjects,
  listMachines,
  setMachineProfile,
  listProfiles,
  addProjectToProfile,
  removeProjectFromProfile,
  listProjectCards,
  loadShellState,
  saveShellState,
  resetShellState,
  readFindings,
  readFindingHistory,
  addFinding,
  editFinding,
  removeFinding,
} from "./data/access.js";
import { PhrenError } from "./shared.js";
import { grantAdmin, makeTempDir, resultMsg, spawnTsxWorker, REPO_ROOT } from "./test-helpers.js";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

let tmpDir: string;
let projectDir: string;
const PROJECT = "testproject";

const runDataAccessWorker = spawnTsxWorker;

let tmpCleanup: () => void;

beforeEach(() => {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("phren-da-test-"));
  projectDir = path.join(tmpDir, PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  grantAdmin(tmpDir);
});

afterEach(() => {
  tmpCleanup();
  delete process.env.PHREN_ACTOR;
});

const SAMPLE_TASK = `# testproject tasks

## Active

- [ ] Implement auth middleware [high]
- [ ] Write integration tests

## Queue

- [ ] Add rate limiting
- [ ] Refactor database layer [medium]

## Done

- [x] Set up CI pipeline
`;

const SAMPLE_FINDINGS = `# testproject FINDINGS

## 2026-03-01

- The auth middleware runs before rate limiting, order matters
  <!-- phren:cite {"created_at":"2026-03-01T10:00:00Z"} -->
- SQLite WAL mode is required for concurrent readers

## 2026-02-15

- vitest needs pool: "forks" when testing native addons
`;











describe("readFindings", () => {
  it("parses dated entries with citations", () => {
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), SAMPLE_FINDINGS);
    const result = readFindings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toHaveLength(3);

    expect(result.data[0].date).toBe("2026-03-01");
    expect(result.data[0].text).toContain("auth middleware");
    expect(result.data[0].citation).toContain("phren:cite");

    expect(result.data[1].date).toBe("2026-03-01");
    expect(result.data[1].text).toContain("WAL mode");
    expect(result.data[1].citation).toBeUndefined();

    expect(result.data[2].date).toBe("2026-02-15");
    expect(result.data[2].text).toContain("vitest");
  });

  it("returns an empty array when no FINDINGS.md exists", () => {
    const result = readFindings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(0);
  });

  it("returns an error for a missing project", () => {
    const result = readFindings(tmpDir, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PhrenError.PROJECT_NOT_FOUND);
  });

  it("assigns sequential IDs", () => {
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), SAMPLE_FINDINGS);
    const result = readFindings(tmpDir, PROJECT);
    if (!result.ok) return;
    expect(result.data[0].id).toBe("L1");
    expect(result.data[1].id).toBe("L2");
    expect(result.data[2].id).toBe("L3");
  });

  it("strips inline provenance comments and parses structured metadata", () => {
    fs.writeFileSync(
      path.join(projectDir, "FINDINGS.md"),
      `# ${PROJECT} FINDINGS

## 2026-03-09

- Refactor slices should stay independently releasable <!-- created: 2026-03-09 --> <!-- source: source:agent machine:testbox actor:codex tool:codex model:gpt-5 session:session-1234 -->
  <!-- phren:cite {"created_at":"2026-03-09T10:00:00Z","task_item":"deadbeef"} -->
`,
    );
    const result = readFindings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toHaveLength(1);
    expect(result.data[0].text).toBe("Refactor slices should stay independently releasable");
  });

  it("parses scope from old source comment format", () => {
    fs.writeFileSync(
      path.join(projectDir, "FINDINGS.md"),
      `# ${PROJECT} FINDINGS

## 2026-03-09

- Legacy finding with scope in source comment <!-- source:agent scope:builder -->
`,
    );
    const result = readFindings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toHaveLength(1);
    expect(result.data[0].scope).toBe("builder");
  });

  it("parses scope from standalone scope comment", () => {
    fs.writeFileSync(
      path.join(projectDir, "FINDINGS.md"),
      `# ${PROJECT} FINDINGS

## 2026-03-09

- Modern finding with standalone scope <!-- scope:builder -->
`,
    );
    const result = readFindings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toHaveLength(1);
    expect(result.data[0].scope).toBe("builder");
  });

  it("excludes archived details by default and includes them when requested", () => {
    fs.writeFileSync(
      path.join(projectDir, "FINDINGS.md"),
      `# ${PROJECT} FINDINGS

## 2026-03-10

- Current finding remains visible <!-- fid:aaaabbbb --> <!-- phren:status "active" -->

<details>
<summary>Archived</summary>

## 2026-02-01

- Archived finding from details <!-- fid:ccccdddd --> <!-- phren:status "superseded" --> <!-- phren:status_updated "2026-02-03" --> <!-- phren:status_reason "superseded_by" --> <!-- phren:status_ref "new-approach" -->
</details>
`,
    );

    const currentOnly = readFindings(tmpDir, PROJECT);
    expect(currentOnly.ok).toBe(true);
    if (!currentOnly.ok) return;
    expect(currentOnly.data).toHaveLength(1);
    expect(currentOnly.data[0].tier).toBe("current");

    const withArchived = readFindings(tmpDir, PROJECT, { includeArchived: true });
    expect(withArchived.ok).toBe(true);
    if (!withArchived.ok) return;
    expect(withArchived.data).toHaveLength(2);
    const archived = withArchived.data.find((entry) => entry.stableId === "ccccdddd");
    expect(archived?.tier).toBe("archived");
    expect(archived?.status).toBe("superseded");
    expect(archived?.status_updated).toBe("2026-02-03");
    expect(archived?.status_reason).toBe("superseded_by");
    expect(archived?.status_ref).toBe("new-approach");
  });
});

describe("readFindingHistory", () => {
  it("reconstructs timeline from current + archived findings", () => {
    fs.writeFileSync(
      path.join(projectDir, "FINDINGS.md"),
      `# ${PROJECT} FINDINGS

## 2026-03-12

- Current finding text <!-- fid:aa11bb22 --> <!-- phren:status "active" --> <!-- phren:status_updated "2026-03-12" -->

<details>
<summary>Archived</summary>

## 2026-02-10

- Current finding text <!-- fid:aa11bb22 --> <!-- phren:status "superseded" --> <!-- phren:status_updated "2026-02-10" --> <!-- phren:status_reason "superseded_by" --> <!-- phren:status_ref "replacement" -->
</details>
`,
    );

    const result = readFindingHistory(tmpDir, PROJECT, "fid:aa11bb22");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0].archivedCount).toBe(1);
    expect(result.data[0].current?.status).toBe("active");
    expect(result.data[0].timeline.map((entry) => entry.status)).toEqual(["superseded", "active"]);
  });
});

describe("addFinding", () => {
  it("creates FINDINGS.md and appends under today's date", () => {
    const msg = addFinding(tmpDir, PROJECT, "New insight about caching");
    expect(resultMsg(msg)).toContain("Created FINDINGS.md");

    const result = readFindings(tmpDir, PROJECT);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0].text).toContain("caching");

    const today = new Date().toISOString().slice(0, 10);
    expect(result.data[0].date).toBe(today);
  });

  it("appends to an existing FINDINGS.md", () => {
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), SAMPLE_FINDINGS);
    const msg = addFinding(tmpDir, PROJECT, "Another insight");
    expect(resultMsg(msg).toLowerCase()).toContain("added");

    const result = readFindings(tmpDir, PROJECT);
    if (!result.ok) return;
    expect(result.data.length).toBeGreaterThan(3);
    // New findings are inserted under today's date at the top of the file
    const found = result.data.find((l) => l.text.includes("Another insight"));
    expect(found).toBeDefined();
    expect(found!.date).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe("removeFinding", () => {
  it("removes a matching finding entry", () => {
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), SAMPLE_FINDINGS);
    const msg = removeFinding(tmpDir, PROJECT, "WAL mode");
    expect(resultMsg(msg)).toContain("Removed");

    const result = readFindings(tmpDir, PROJECT);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    expect(result.data.every((l) => !l.text.includes("WAL mode"))).toBe(true);
  });

  it("removes a finding along with its citation comment", () => {
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), SAMPLE_FINDINGS);
    const msg = removeFinding(tmpDir, PROJECT, "auth middleware");
    expect(resultMsg(msg)).toContain("Removed");

    const content = fs.readFileSync(path.join(projectDir, "FINDINGS.md"), "utf8");
    expect(content).not.toContain("auth middleware");
    expect(content).not.toContain("phren:cite");
  });

  it("returns an error when no finding matches", () => {
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), SAMPLE_FINDINGS);
    const msg = removeFinding(tmpDir, PROJECT, "nonexistent xyz");
    expect(resultMsg(msg)).toContain("No finding matching");
  });

  it("returns an error when FINDINGS.md does not exist", () => {
    const msg = removeFinding(tmpDir, PROJECT, "anything");
    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.code).toBe(PhrenError.FILE_NOT_FOUND);
  });

  it("refuses to remove archived findings", () => {
    fs.writeFileSync(
      path.join(projectDir, "FINDINGS.md"),
      [
        "# testproject FINDINGS",
        "",
        "## 2026-03-01",
        "",
        "- Active finding",
        "",
        "<!-- phren:archive:start -->",
        "## Archived 2026-02-01",
        "",
        "- Archived finding",
        "<!-- phren:archive:end -->",
        "",
      ].join("\n"),
    );

    const msg = removeFinding(tmpDir, PROJECT, "Archived finding");
    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.code).toBe(PhrenError.VALIDATION_ERROR);

    const content = fs.readFileSync(path.join(projectDir, "FINDINGS.md"), "utf8");
    expect(content).toContain("- Archived finding");
  });
});

describe("editFinding", () => {
  it("updates an active finding in place", () => {
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), SAMPLE_FINDINGS);
    const msg = editFinding(tmpDir, PROJECT, "WAL mode", "SQLite WAL mode prevents reader blocking");
    expect(msg.ok).toBe(true);

    const content = fs.readFileSync(path.join(projectDir, "FINDINGS.md"), "utf8");
    expect(content).toContain("SQLite WAL mode prevents reader blocking");
    expect(content).not.toContain("WAL mode reduces writer contention");
  });

  it("refuses to edit archived findings", () => {
    fs.writeFileSync(
      path.join(projectDir, "FINDINGS.md"),
      [
        "# testproject FINDINGS",
        "",
        "## 2026-03-01",
        "",
        "- Active finding",
        "",
        "<!-- phren:archive:start -->",
        "## Archived 2026-02-01",
        "",
        "- Archived finding <!-- fid:deadbeef -->",
        "<!-- phren:archive:end -->",
        "",
      ].join("\n"),
    );

    const msg = editFinding(tmpDir, PROJECT, "Archived finding", "Edited archived finding");
    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.code).toBe(PhrenError.VALIDATION_ERROR);

    const content = fs.readFileSync(path.join(projectDir, "FINDINGS.md"), "utf8");
    expect(content).toContain("- Archived finding <!-- fid:deadbeef -->");
    expect(content).not.toContain("Edited archived finding");
  });
});

describe("review queue helpers", () => {
  beforeEach(() => {
    const queue = `# testproject Review Queue

## Review

- [2026-03-01] cleanup flaky test [confidence 0.4]

## Stale

- [2025-01-01] old stale memory

## Conflicts

- [2026-03-02] conflicting guidance
`;
    fs.writeFileSync(path.join(projectDir, "review.md"), queue);
  });

  it("readReviewQueue parses sections and confidence", () => {
    const result = readReviewQueue(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(3);
    expect(result.data[0].section).toBe("Review");
    expect(result.data[0].confidence).toBe(0.4);
  });

  it("readReviewQueueAcrossProjects aggregates items with project metadata", () => {
    const secondProjectDir = path.join(tmpDir, "bravo");
    fs.mkdirSync(secondProjectDir, { recursive: true });
    fs.writeFileSync(
      path.join(secondProjectDir, "review.md"),
      [
        "# bravo Review Queue",
        "",
        "## Review",
        "",
        "- [2026-03-04] bravo review",
        "",
        "## Stale",
        "",
        "## Conflicts",
        "",
        "- [2026-03-05] bravo conflict",
        "",
      ].join("\n"),
    );

    const result = readReviewQueueAcrossProjects(tmpDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(5);
    expect(result.data.every((item) => item.project === PROJECT || item.project === "bravo")).toBe(true);
    expect(result.data.filter((item) => item.section === "Review")).toHaveLength(2);
    expect(result.data.some((item) => item.project === "bravo" && item.section === "Conflicts")).toBe(true);
  });

  it("returns an error when aggregate queue profile is malformed", () => {
    fs.mkdirSync(path.join(tmpDir, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "profiles", "broken.yaml"), "name: broken\nprojects: nope\n");

    const result = readReviewQueueAcrossProjects(tmpDir, "broken");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PhrenError.MALFORMED_YAML);
  });

});

describe("machines, profiles, and shell state", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "machines.yaml"), "machine-a: personal\n");
    fs.writeFileSync(path.join(tmpDir, "profiles", "personal.yaml"), "name: personal\nprojects:\n  - testproject\n");
  });

  it("lists and updates machines", () => {
    const listed = listMachines(tmpDir);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data["machine-a"]).toBe("personal");

    const msg = setMachineProfile(tmpDir, "machine-b", "personal");
    expect(resultMsg(msg)).toContain("Mapped machine machine-b");
    const after = listMachines(tmpDir);
    if (!after.ok) return;
    expect(after.data["machine-b"]).toBe("personal");
    expect(after.data["machine-a"]).toBe("personal");
  });

  it("returns FILE_NOT_FOUND when machines.yaml is missing", () => {
    fs.unlinkSync(path.join(tmpDir, "machines.yaml"));
    const listed = listMachines(tmpDir);
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.code).toBe(PhrenError.FILE_NOT_FOUND);
  });

  // machines.yaml is git-synced, so conflict markers are the likely parse
  // failure, and rebuilding it from an empty map dropped every other mapping.
  it("refuses to rewrite a machines.yaml it cannot parse", () => {
    const machinesPath = path.join(tmpDir, "machines.yaml");
    const conflicted = "laptop: personal\n<<<<<<< HEAD\ndesktop: personal\n=======\ndesktop: work\n>>>>>>> origin/main\nserver: personal\n";
    fs.writeFileSync(machinesPath, conflicted);

    const result = setMachineProfile(tmpDir, "newbox", "personal");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PhrenError.MALFORMED_YAML);
    expect(fs.readFileSync(machinesPath, "utf8")).toBe(conflicted);
  });

  // The shipped starter machines.yaml is all comments, which listMachines also
  // reports as MALFORMED_YAML; `phren init --machine` must still write into it.
  it("writes into a comments-only machines.yaml", () => {
    fs.writeFileSync(path.join(tmpDir, "machines.yaml"), "# Map machine hostnames to profiles.\n#\n#   work-laptop: work\n\n");
    expect(setMachineProfile(tmpDir, "test-box", "personal").ok).toBe(true);
    const listed = listMachines(tmpDir);
    expect(listed.ok && listed.data["test-box"]).toBe("personal");
  });

  // writeProfile re-dumped only name/description/projects, so every profile
  // add/remove (and rename, which is remove-then-add) wiped the defaults block.
  it("keeps a profile's defaults block and header comment across add and remove", () => {
    const profilePath = path.join(tmpDir, "profiles", "personal.yaml");
    fs.writeFileSync(
      profilePath,
      "# my personal profile\nname: personal\nprojects:\n  - testproject\ndefaults:\n  findingSensitivity: aggressive\n  retentionPolicy:\n    ttlDays: 400\n",
    );

    expect(addProjectToProfile(tmpDir, "personal", "another-proj").ok).toBe(true);
    expect(removeProjectFromProfile(tmpDir, "personal", "another-proj").ok).toBe(true);

    const profile = listProfiles(tmpDir);
    const personal = profile.ok ? profile.data.find((entry) => entry.name === "personal") : undefined;
    expect(personal?.projects).toEqual(["testproject"]);
    expect(personal?.defaults).toEqual({ findingSensitivity: "aggressive", retentionPolicy: { ttlDays: 400 } });
    expect(fs.readFileSync(profilePath, "utf8")).toMatch(/^# my personal profile\n/);
  });

  it("returns MALFORMED_YAML for invalid machines.yaml", () => {
    fs.writeFileSync(path.join(tmpDir, "machines.yaml"), "machine-a: [\n");
    const listed = listMachines(tmpDir);
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.code).toBe(PhrenError.MALFORMED_YAML);
  });

  it("lists profiles and mutates profile projects", () => {
    const listed = listProfiles(tmpDir);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data[0].name).toBe("personal");

    const addMsg = addProjectToProfile(tmpDir, "personal", "another-proj");
    expect(resultMsg(addMsg)).toContain("Added another-proj");
    const removeMsg = removeProjectFromProfile(tmpDir, "personal", "another-proj");
    expect(resultMsg(removeMsg)).toContain("Removed another-proj");
  });

  it("returns FILE_NOT_FOUND when profiles directory is missing", () => {
    fs.rmSync(path.join(tmpDir, "profiles"), { recursive: true, force: true });
    const listed = listProfiles(tmpDir);
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.code).toBe(PhrenError.FILE_NOT_FOUND);
  });

  it("returns MALFORMED_YAML for invalid profile yaml", () => {
    fs.writeFileSync(path.join(tmpDir, "profiles", "personal.yaml"), "name: personal\nprojects: [\n");
    const listed = listProfiles(tmpDir);
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.code).toBe(PhrenError.MALFORMED_YAML);
  });

  it("listProjectCards includes summary/docs", () => {
    fs.writeFileSync(path.join(projectDir, "summary.md"), "# testproject\n\nQuick summary line\n");
    fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "# testproject\n");
    fs.writeFileSync(path.join(projectDir, "tasks.md"), SAMPLE_TASK);

    const cards = listProjectCards(tmpDir);
    const card = cards.find((c) => c.name === PROJECT);
    expect(card).toBeDefined();
    expect(card?.summary).toContain("Quick summary");
  });

  // A profile lists projects in the primary store, so a team store's projects
  // never appear in it — filtering them through the profile hid every one.
  it("listProjectCards lists team-store projects the profile does not name", () => {
    const teamDir = path.join(tmpDir, "..", `team-${path.basename(tmpDir)}`);
    fs.mkdirSync(path.join(teamDir, "teamproj"), { recursive: true });
    fs.writeFileSync(path.join(teamDir, "teamproj", "summary.md"), "# teamproj\n\nShared work\n");
    fs.mkdirSync(path.join(tmpDir, "global"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "profiles"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "profiles", "solo.yaml"),
      `name: solo\nprojects:\n  - global\n  - ${PROJECT}\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "stores.yaml"),
      `version: 1\nstores:\n  - id: aaaaaaaa\n    name: primary\n    path: ${tmpDir}\n    role: primary\n    sync: managed-git\n  - id: bbbbbbbb\n    name: team\n    path: ${teamDir}\n    role: team\n    sync: managed-git\n`,
    );

    try {
      const cards = listProjectCards(tmpDir, "solo");
      const team = cards.find((c) => c.name === "teamproj");
      expect(team).toBeDefined();
      expect(team?.store).toBe("team");
      expect(cards.find((c) => c.name === PROJECT)?.store).toBeUndefined();
      // global is pinned to the top, and listed once even though the profile names it.
      expect(cards.filter((c) => c.name === "global")).toHaveLength(1);
      expect(cards[0].name).toBe("global");
    } finally {
      fs.rmSync(teamDir, { recursive: true, force: true });
    }
  });

  it("save/load/reset shell state round trips", () => {
    saveShellState(tmpDir, {
      version: 1,
      view: "Findings",
      project: PROJECT,
      filter: "auth",
      page: 2,
      perPage: 25,
    });
    const loaded = loadShellState(tmpDir);
    expect(loaded.view).toBe("Findings");
    expect(loaded.project).toBe(PROJECT);
    expect(loaded.filter).toBe("auth");
    expect(loaded.page).toBe(2);
    expect(loaded.perPage).toBe(25);

    const msg = resetShellState(tmpDir);
    expect(resultMsg(msg)).toContain("reset");
    const fallback = loadShellState(tmpDir);
    expect(fallback.view).toBe("Projects");
  });
});

describe("file locking", () => {


  it("two sequential addFinding calls produce valid FINDINGS.md", () => {
    addFinding(tmpDir, PROJECT, "First finding");
    addFinding(tmpDir, PROJECT, "Second finding");

    const result = readFindings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const texts = result.data.map((l) => l.text);
    expect(texts.some((t) => t.includes("First finding"))).toBe(true);
    expect(texts.some((t) => t.includes("Second finding"))).toBe(true);
  });















  it.skipIf(process.platform === "win32")("allows concurrent finding writes from two processes without data loss", async () => {
    // Use forward slashes in import paths for Windows compatibility
    const dataAccessPath = path.join(REPO_ROOT, "packages/cli/src/data/access.ts").replace(/\\/g, "/");
    const mkCode = (text: string) =>
      `import { addFinding } from ${JSON.stringify(dataAccessPath)};` +
      `process.env.PHREN_ACTOR='vitest-admin';` +
      `const out=addFinding(${JSON.stringify(tmpDir)},${JSON.stringify(PROJECT)},${JSON.stringify(text)});` +
      `console.log(out.ok ? out.data : out.error); if(!out.ok && out.error.includes('LOCK_TIMEOUT')) process.exit(2);`;

    const [a, b] = await Promise.all([
      runDataAccessWorker(mkCode("Use writeFileSync with wx flag to atomically create lock files")),
      runDataAccessWorker(mkCode("Debounce disk flushes to avoid hammering storage on every event")),
    ]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);

    const result = readFindings(tmpDir, PROJECT);
    if (!result.ok) return;
    const texts = result.data.map((l) => l.text);
    expect(texts.some((t) => t.includes("writeFileSync with wx flag"))).toBe(true);
    expect(texts.some((t) => t.includes("Debounce disk flushes"))).toBe(true);
  });
});

// --- findItemByMatch returns explicit error on no match ---



// --- Task header whitespace tolerance ---



// --- Structured error codes ---

describe("structured error codes in data-access", () => {






  it("removeFinding returns NOT_FOUND for unmatched finding", () => {
    // Ensure FINDINGS.md exists so the search runs
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), "# FINDINGS\n\n## 2025-01-01\n\n- Existing finding\n");
    const msg = removeFinding(tmpDir, PROJECT, "nonexistent-finding-xyz");
    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.code).toBe(PhrenError.NOT_FOUND);
  });

  it("listMachines returns FILE_NOT_FOUND when machines.yaml missing", () => {
    const tmp = makeTempDir("phren-err-");
    try {
      const result = listMachines(tmp.path);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(PhrenError.FILE_NOT_FOUND);
    } finally {
      tmp.cleanup();
    }
  });
});

// ── Path-escape guards ─────────────────────────────────────────────────────

describe("path-escape guards", () => {
  it("addFinding rejects a project name containing path traversal", () => {
    const result = addFinding(tmpDir, "../escape", "some finding");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PhrenError.INVALID_PROJECT_NAME);
  });

  it("removeFinding rejects a project name containing path traversal", () => {
    const result = removeFinding(tmpDir, "../escape", "some finding");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PhrenError.INVALID_PROJECT_NAME);
  });

  it("removeFinding blocks a symlinked project dir that resolves outside phrenPath", () => {
    // Create a target directory outside phrenPath
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-escape-"));
    try {
      const findings = path.join(outsideDir, "FINDINGS.md");
      fs.writeFileSync(findings, "# escape Findings\n\n## 2026-01-01\n\n- secret\n");

      // Create a symlink inside phrenPath pointing to outside dir
      const symlinkPath = path.join(tmpDir, "symlinked");
      fs.symlinkSync(outsideDir, symlinkPath);

      const result = removeFinding(tmpDir, "symlinked", "secret");
      // safeProjectPath detects the symlink escape and blocks it
      expect(result.ok).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
