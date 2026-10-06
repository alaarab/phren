import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";
import { writeStoreRegistry, type StoreRegistry } from "./store-registry.js";
import { parseStoreQualified, resolveProject, listAllProjects } from "./store-routing.js";

describe("store-routing", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenDir: string;
  const origFedPaths = process.env.PHREN_FEDERATION_PATHS;

  beforeEach(() => {
    tmp = makeTempDir("store-routing-test-");
    phrenDir = path.join(tmp.path, ".phren");
    fs.mkdirSync(phrenDir, { recursive: true });
    delete process.env.PHREN_FEDERATION_PATHS;
  });

  afterEach(() => {
    if (origFedPaths !== undefined) {
      process.env.PHREN_FEDERATION_PATHS = origFedPaths;
    } else {
      delete process.env.PHREN_FEDERATION_PATHS;
    }
    tmp.cleanup();
  });

  function createProject(storePath: string, projectName: string): void {
    const dir = path.join(storePath, projectName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "FINDINGS.md"), `# ${projectName}\n`);
  }

  // ── parseStoreQualified ──────────────────────────────────────────────────

  describe("parseStoreQualified", () => {
    it("parses bare project name", () => {
      expect(parseStoreQualified("forge")).toEqual({ projectName: "forge" });
    });

    it("parses store-qualified name", () => {
      expect(parseStoreQualified("forge-team/forge")).toEqual({
        storeName: "forge-team",
        projectName: "forge",
      });
    });

    it("trims whitespace", () => {
      expect(parseStoreQualified("  my-store/my-project  ")).toEqual({
        storeName: "my-store",
        projectName: "my-project",
      });
    });

    it("handles names with hyphens and numbers", () => {
      expect(parseStoreQualified("team-42/project-99")).toEqual({
        storeName: "team-42",
        projectName: "project-99",
      });
    });

    it("treats double-slash as bare name (malformed)", () => {
      const result = parseStoreQualified("a/b/c");
      // Second slash in projectName → treat as bare (will fail validation)
      expect(result.projectName).toContain("/");
    });
  });

  // ── resolveProject ───────────────────────────────────────────────────────

  describe("resolveProject", () => {
    it("resolves a bare project in single-store mode (no stores.yaml)", () => {
      createProject(phrenDir, "forge");

      const result = resolveProject(phrenDir, "forge");
      expect(result.projectName).toBe("forge");
      expect(result.store.role).toBe("primary");
      expect(result.projectDir).toBe(path.join(phrenDir, "forge"));
    });

    it("resolves a store-qualified project", () => {
      const teamDir = path.join(tmp.path, "team-store");
      fs.mkdirSync(teamDir, { recursive: true });
      createProject(phrenDir, "personal-project");
      createProject(teamDir, "team-project");

      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "personal", path: phrenDir, role: "primary", sync: "managed-git" },
          { id: "bbb22222", name: "forge-team", path: teamDir, role: "team", sync: "managed-git" },
        ],
      };
      writeStoreRegistry(phrenDir, registry);

      const result = resolveProject(phrenDir, "forge-team/team-project");
      expect(result.store.name).toBe("forge-team");
      expect(result.projectName).toBe("team-project");
    });

    it("throws for ambiguous bare project across stores", () => {
      const teamDir = path.join(tmp.path, "team-store");
      fs.mkdirSync(teamDir, { recursive: true });
      createProject(phrenDir, "forge");
      createProject(teamDir, "forge");

      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "personal", path: phrenDir, role: "primary", sync: "managed-git" },
          { id: "bbb22222", name: "forge-team", path: teamDir, role: "team", sync: "managed-git" },
        ],
      };
      writeStoreRegistry(phrenDir, registry);

      expect(() => resolveProject(phrenDir, "forge")).toThrow(/multiple stores/);
      expect(() => resolveProject(phrenDir, "forge")).toThrow(/personal\/forge/);
      expect(() => resolveProject(phrenDir, "forge")).toThrow(/forge-team\/forge/);
    });

    it("throws for project not found", () => {
      expect(() => resolveProject(phrenDir, "nonexistent")).toThrow(/not found/);
    });

    it("throws for unknown store in qualified ref", () => {
      expect(() => resolveProject(phrenDir, "fake-store/forge")).toThrow(/Store "fake-store" not found/);
    });

    it("throws for invalid project name", () => {
      expect(() => resolveProject(phrenDir, "UPPERCASE")).toThrow(/Invalid project name/);
    });

    it("throws for path traversal in store-qualified ref", () => {
      expect(() => resolveProject(phrenDir, "../traversal")).toThrow(/Invalid store name/);
    });

    it("resolves unique project across multiple stores without qualification", () => {
      const teamDir = path.join(tmp.path, "team-store");
      fs.mkdirSync(teamDir, { recursive: true });
      createProject(phrenDir, "personal-only");
      createProject(teamDir, "team-only");

      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "personal", path: phrenDir, role: "primary", sync: "managed-git" },
          { id: "bbb22222", name: "forge-team", path: teamDir, role: "team", sync: "managed-git" },
        ],
      };
      writeStoreRegistry(phrenDir, registry);

      // Each project is unique to its store — bare name works
      const r1 = resolveProject(phrenDir, "personal-only");
      expect(r1.store.name).toBe("personal");

      const r2 = resolveProject(phrenDir, "team-only");
      expect(r2.store.name).toBe("forge-team");
    });
  });

  // ── listAllProjects ──────────────────────────────────────────────────────

  describe("listAllProjects", () => {
    it("lists projects from single store", () => {
      createProject(phrenDir, "forge");
      createProject(phrenDir, "emv");

      const projects = listAllProjects(phrenDir);
      const names = projects.map((p) => p.projectName);
      expect(names).toContain("forge");
      expect(names).toContain("emv");
    });

    it("lists projects across multiple stores", () => {
      const teamDir = path.join(tmp.path, "team-store");
      fs.mkdirSync(teamDir, { recursive: true });
      createProject(phrenDir, "personal-proj");
      createProject(teamDir, "team-proj");

      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "personal", path: phrenDir, role: "primary", sync: "managed-git" },
          { id: "bbb22222", name: "team", path: teamDir, role: "team", sync: "managed-git" },
        ],
      };
      writeStoreRegistry(phrenDir, registry);

      const projects = listAllProjects(phrenDir);
      expect(projects).toHaveLength(2);
      expect(projects.find((p) => p.projectName === "personal-proj")?.store.name).toBe("personal");
      expect(projects.find((p) => p.projectName === "team-proj")?.store.name).toBe("team");
    });

    it("returns empty for store with no projects", () => {
      const projects = listAllProjects(phrenDir);
      expect(projects).toHaveLength(0);
    });
  });
});
