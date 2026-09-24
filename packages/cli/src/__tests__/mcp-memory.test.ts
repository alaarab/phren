import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { upsertCanonical } from "../content/learning.js";

const PROJECT = "myapp";

let tmp: { path: string; cleanup: () => void };

function seedProject(phrenPath: string, project = PROJECT) {
  const dir = path.join(phrenPath, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.md"), `# ${project}\n`);
}

function canonicalPath(project = PROJECT) {
  return path.join(tmp.path, project, "truths.md");
}

beforeEach(() => {
  tmp = makeTempDir("mcp-memory-test-");
  grantAdmin(tmp.path);
  seedProject(tmp.path);
});

afterEach(() => {
  delete process.env.PHREN_ACTOR;
  tmp.cleanup();
});

describe("pin_memory MCP tool", () => {
  it("appends to existing truths.md without duplicating", () => {
    upsertCanonical(tmp.path, PROJECT, "First truth");
    upsertCanonical(tmp.path, PROJECT, "Second truth");

    const content = fs.readFileSync(canonicalPath(), "utf-8");
    expect(content).toContain("First truth");
    expect(content).toContain("Second truth");
  });

  it("returns error for nonexistent project", () => {
    const r = upsertCanonical(tmp.path, "nonexistent-project", "Should fail");
    expect(r.ok).toBe(false);
  });

  it("returns error for invalid project name", () => {
    const r = upsertCanonical(tmp.path, "../escape", "Should fail");
    expect(r.ok).toBe(false);
  });

  it("includes added date in the entry", () => {
    upsertCanonical(tmp.path, PROJECT, "Memory with date");
    const content = fs.readFileSync(canonicalPath(), "utf-8");
    const today = new Date().toISOString().slice(0, 10);
    expect(content).toContain(`added ${today}`);
  });
});

