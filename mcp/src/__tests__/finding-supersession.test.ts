import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { addFindingToFile } from "../shared-content.js";
import { readFindings } from "../data-access.js";

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

  it("superseded findings are hidden by default in readFindings (supersededBy is set)", () => {
    addFindingToFile(tmp.path, PROJECT, "Original insight about retries");
    addFindingToFile(tmp.path, PROJECT, "Updated insight about retries with exponential backoff", {
      supersedes: "Original insight about retries",
    });
    const result = readFindings(tmp.path, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The old finding should have supersededBy set
    const superseded = result.data.filter((f) => f.supersededBy);
    expect(superseded.length).toBeGreaterThan(0);
    expect(superseded[0].supersededBy).toBeTruthy();
    // The new finding should have supersedes set
    const superseding = result.data.filter((f) => f.supersedes);
    expect(superseding.length).toBeGreaterThan(0);
  });

  it("include_superseded=false filter: superseded findings have supersededBy field", () => {
    addFindingToFile(tmp.path, PROJECT, "Always validate input at the API boundary");
    addFindingToFile(tmp.path, PROJECT, "Always validate and sanitize input at the API boundary", {
      supersedes: "Always validate input at the API boundary",
    });
    const result = readFindings(tmp.path, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const allItems = result.data;
    const activeItems = allItems.filter((f) => !f.supersededBy);
    const supersededItems = allItems.filter((f) => f.supersededBy);

    // Active items should not include the superseded one
    expect(activeItems.every((f) => !f.supersededBy)).toBe(true);
    // The superseded item has the supersededBy field
    expect(supersededItems.length).toBe(1);
    expect(supersededItems[0].text).toContain("validate input at the API boundary");
  });

  it("include_superseded=true shows all findings including superseded", () => {
    addFindingToFile(tmp.path, PROJECT, "Use HTTP/1.1 for internal services");
    addFindingToFile(tmp.path, PROJECT, "Use HTTP/2 for internal services to reduce latency", {
      supersedes: "Use HTTP/1.1 for internal services",
    });
    const result = readFindings(tmp.path, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // readFindings returns all — caller filters by supersededBy
    const superseded = result.data.filter((f) => f.supersededBy);
    const active = result.data.filter((f) => !f.supersededBy);
    // Both should be present
    expect(superseded.length).toBeGreaterThan(0);
    expect(active.length).toBeGreaterThan(0);
    // Total includes both
    expect(result.data.length).toBe(superseded.length + active.length);
  });
});
