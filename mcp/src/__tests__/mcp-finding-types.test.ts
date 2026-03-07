import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { addFindingToFile } from "../content-learning.js";

function seedProject(cortexPath: string, project = "myapp") {
  const dir = path.join(cortexPath, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.md"), `# ${project}\n`);
}

describe("typed findings (decision|pitfall|pattern)", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("mcp-finding-types-");
    grantAdmin(tmp.path);
    seedProject(tmp.path);
  });
  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    tmp.cleanup();
  });

  function findingsPath(project = "myapp") {
    return path.join(tmp.path, project, "FINDINGS.md");
  }

  it("stores a [decision] tag inline", () => {
    const r = addFindingToFile(tmp.path, "myapp", "[decision] Use PostgreSQL over MySQL for full-text search");
    expect(r.ok).toBe(true);
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("[decision] Use PostgreSQL over MySQL");
  });

  it("stores a [pitfall] tag inline", () => {
    const r = addFindingToFile(tmp.path, "myapp", "[pitfall] Redis connections must be closed in finally blocks");
    expect(r.ok).toBe(true);
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("[pitfall] Redis connections");
  });

  it("stores a [pattern] tag inline", () => {
    const r = addFindingToFile(tmp.path, "myapp", "[pattern] Use repository pattern to separate data access from business logic");
    expect(r.ok).toBe(true);
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("[pattern] Use repository pattern");
  });

  it("stores untagged findings without modification", () => {
    const r = addFindingToFile(tmp.path, "myapp", "Always restart the service after env changes");
    expect(r.ok).toBe(true);
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("Always restart the service after env changes");
    expect(content).not.toMatch(/- \[(decision|pitfall|pattern)\]/);
  });

  it("normalizes tag casing to lowercase", () => {
    addFindingToFile(tmp.path, "myapp", "[DECISION] Use monorepo");
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("[decision] Use monorepo");
  });

  it("all three types can coexist in the same FINDINGS.md", () => {
    addFindingToFile(tmp.path, "myapp", "[decision] Use Redis for caching");
    addFindingToFile(tmp.path, "myapp", "[pitfall] Avoid N+1 queries");
    addFindingToFile(tmp.path, "myapp", "[pattern] Use optimistic locking for concurrent writes");
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("[decision]");
    expect(content).toContain("[pitfall]");
    expect(content).toContain("[pattern]");
  });
});
