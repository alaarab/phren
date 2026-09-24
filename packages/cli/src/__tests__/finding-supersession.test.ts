import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { addFindingToFile } from "../shared/content.js";
import { readFindings } from "../data/access.js";

const PROJECT = "myapp";

let tmp: { path: string; cleanup: () => void };

function seedProject(phrenPath: string, project = PROJECT) {
  const dir = path.join(phrenPath, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.md"), `# ${project}\n`);
}

function findingsPath(project = PROJECT) {
  return path.join(tmp.path, project, "FINDINGS.md");
}

beforeEach(() => {
  tmp = makeTempDir("finding-supersession-test-");
  grantAdmin(tmp.path);
  seedProject(tmp.path);
});

afterEach(() => {
  tmp.cleanup();
});

describe("finding supersession annotations", () => {
  it("adds phren:superseded_by annotation to the old finding", () => {
    addFindingToFile(tmp.path, PROJECT, "Use SQLite WAL mode for concurrent readers");
    addFindingToFile(tmp.path, PROJECT, "Use SQLite WAL mode plus connection pooling for concurrent readers", {
      supersedes: "Use SQLite WAL mode for concurrent readers",
    });
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toMatch(/phren:superseded_by/);
    expect(content).toMatch(/Use SQLite WAL mode for concurrent readers/);
  });

  it("adds phren:supersedes annotation to the new finding", () => {
    addFindingToFile(tmp.path, PROJECT, "Cache responses at the CDN layer");
    addFindingToFile(tmp.path, PROJECT, "Cache responses at the CDN layer with stale-while-revalidate", {
      supersedes: "Cache responses at the CDN layer",
    });
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toMatch(/phren:supersedes/);
  });

  it("readFindings marks exactly the old finding as superseded", () => {
    addFindingToFile(tmp.path, PROJECT, "Original insight about retries");
    addFindingToFile(tmp.path, PROJECT, "Updated insight about retries with exponential backoff", {
      supersedes: "Original insight about retries",
    });
    const result = readFindings(tmp.path, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const superseded = result.data.filter((f) => f.supersededBy);
    expect(superseded).toHaveLength(1);
    expect(superseded[0].text).toContain("Original insight about retries");
    // The new finding should have supersedes set
    const superseding = result.data.filter((f) => f.supersedes);
    expect(superseding.length).toBeGreaterThan(0);
  });
});
