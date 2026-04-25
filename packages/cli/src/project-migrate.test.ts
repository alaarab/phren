import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { makeTempDir, initTestPhrenRoot } from "./test-helpers.js";
import { getProjectDirs, listInvalidProjectDirs } from "./phren-paths.js";
import { migrateInvalidProjectNames } from "./project-migrate.js";

describe("invalid project name handling", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenDir: string;

  beforeEach(() => {
    tmp = makeTempDir("phren-migrate-");
    phrenDir = path.join(tmp.path, ".phren");
    fs.mkdirSync(phrenDir, { recursive: true });
    initTestPhrenRoot(phrenDir);
    fs.mkdirSync(path.join(phrenDir, "profiles"), { recursive: true });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  function writeProfileYaml(name: string, projects: string[]): void {
    fs.writeFileSync(
      path.join(phrenDir, "profiles", `${name}.yaml`),
      yaml.dump({ name, projects }),
    );
  }

  describe("getProjectDirs", () => {
    it("excludes directories with uppercase names", () => {
      fs.mkdirSync(path.join(phrenDir, "goodproject"));
      fs.mkdirSync(path.join(phrenDir, "MYPROJECT"));
      fs.mkdirSync(path.join(phrenDir, "MixedCase"));
      const dirs = getProjectDirs(phrenDir).map((d) => path.basename(d));
      expect(dirs).toContain("goodproject");
      expect(dirs).not.toContain("MYPROJECT");
      expect(dirs).not.toContain("MixedCase");
    });

    it("excludes directories with spaces or special characters", () => {
      fs.mkdirSync(path.join(phrenDir, "valid-name"));
      fs.mkdirSync(path.join(phrenDir, "has space"));
      const dirs = getProjectDirs(phrenDir).map((d) => path.basename(d));
      expect(dirs).toContain("valid-name");
      expect(dirs).not.toContain("has space");
    });
  });

  describe("listInvalidProjectDirs", () => {
    it("returns only dirs that fail isValidProjectName", () => {
      fs.mkdirSync(path.join(phrenDir, "good"));
      fs.mkdirSync(path.join(phrenDir, "MYPROJECT"));
      fs.mkdirSync(path.join(phrenDir, "Bad Name"));
      fs.mkdirSync(path.join(phrenDir, "global"));
      const invalid = listInvalidProjectDirs(phrenDir).sort();
      expect(invalid).toEqual(["Bad Name", "MYPROJECT"].sort());
    });

    it("ignores hidden, reserved, and archived entries", () => {
      fs.mkdirSync(path.join(phrenDir, ".config"));
      fs.mkdirSync(path.join(phrenDir, "something.archived"));
      fs.mkdirSync(path.join(phrenDir, "MYPROJECT"));
      const invalid = listInvalidProjectDirs(phrenDir);
      expect(invalid).toEqual(["MYPROJECT"]);
    });

    it("returns empty array on a clean store", () => {
      fs.mkdirSync(path.join(phrenDir, "good"));
      expect(listInvalidProjectDirs(phrenDir)).toEqual([]);
    });
  });

  describe("migrateInvalidProjectNames", () => {
    it("renames an uppercase dir to lowercase and updates profile yaml", () => {
      fs.mkdirSync(path.join(phrenDir, "MYPROJECT"));
      fs.writeFileSync(path.join(phrenDir, "MYPROJECT", "summary.md"), "# test\n");
      writeProfileYaml("default", ["global", "MYPROJECT"]);

      const result = migrateInvalidProjectNames(phrenDir);

      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0]).toMatchObject({
        from: "MYPROJECT",
        to: "myproject",
        action: "renamed",
      });
      expect(fs.existsSync(path.join(phrenDir, "myproject"))).toBe(true);
      expect(fs.existsSync(path.join(phrenDir, "myproject", "summary.md"))).toBe(true);

      const profileRaw = fs.readFileSync(path.join(phrenDir, "profiles", "default.yaml"), "utf8");
      const profile = yaml.load(profileRaw) as { projects: string[] };
      expect(profile.projects).toContain("myproject");
      expect(profile.projects).not.toContain("MYPROJECT");
    });

    it("skips when the target lowercase dir already exists as a separate directory", () => {
      fs.mkdirSync(path.join(phrenDir, "myproject"));
      fs.writeFileSync(path.join(phrenDir, "myproject", "marker-lower"), "lower");
      // On case-insensitive filesystems these two mkdirs would alias; detect
      // that and skip the test because it can't meaningfully test collision.
      let distinct = true;
      try {
        fs.mkdirSync(path.join(phrenDir, "MYPROJECT"));
      } catch {
        distinct = false;
      }
      if (!distinct) return;
      const lowerStat = fs.statSync(path.join(phrenDir, "myproject"));
      const upperStat = fs.statSync(path.join(phrenDir, "MYPROJECT"));
      if (lowerStat.ino === upperStat.ino) return;

      fs.writeFileSync(path.join(phrenDir, "MYPROJECT", "marker-upper"), "upper");

      const result = migrateInvalidProjectNames(phrenDir);

      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0].action).toBe("skipped-collision");
      expect(fs.existsSync(path.join(phrenDir, "myproject", "marker-lower"))).toBe(true);
      expect(fs.existsSync(path.join(phrenDir, "MYPROJECT", "marker-upper"))).toBe(true);
    });

    it("reports skipped-invalid-slug for names lowercasing can't fix", () => {
      fs.mkdirSync(path.join(phrenDir, "Bad Name"));

      const result = migrateInvalidProjectNames(phrenDir);

      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0]).toMatchObject({
        from: "Bad Name",
        action: "skipped-invalid-slug",
      });
      expect(fs.existsSync(path.join(phrenDir, "Bad Name"))).toBe(true);
    });

    it("returns an empty result when everything is already valid", () => {
      fs.mkdirSync(path.join(phrenDir, "goodproject"));
      const result = migrateInvalidProjectNames(phrenDir);
      expect(result.outcomes).toEqual([]);
    });

    it("handles multiple invalid dirs in one pass", () => {
      fs.mkdirSync(path.join(phrenDir, "FOO"));
      fs.mkdirSync(path.join(phrenDir, "Bar"));
      fs.mkdirSync(path.join(phrenDir, "valid"));
      writeProfileYaml("default", ["FOO", "Bar", "valid"]);

      const result = migrateInvalidProjectNames(phrenDir);

      const renamed = result.outcomes.filter((o) => o.action === "renamed");
      expect(renamed.map((o) => `${o.from}->${o.to}`).sort()).toEqual([
        "Bar->bar",
        "FOO->foo",
      ]);

      const profile = yaml.load(
        fs.readFileSync(path.join(phrenDir, "profiles", "default.yaml"), "utf8"),
      ) as { projects: string[] };
      expect(profile.projects.sort()).toEqual(["bar", "foo", "valid"]);
    });
  });
});
