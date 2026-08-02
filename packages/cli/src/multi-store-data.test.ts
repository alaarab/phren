import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";
import { writeStoreRegistry, type StoreRegistry } from "./store-registry.js";
import { storeAwareProjectPath } from "./store-routing.js";
import { appendReviewQueue } from "./governance/policy.js";
import { ensureProject } from "./shared/data-utils.js";
import { PhrenError } from "./shared.js";
import {
  addTask,
  canonicalTaskFilePath,
  completeTask,
  readTasks,
  removeTask,
} from "./data/tasks.js";
import { addFinding, readFindings, removeFinding, readReviewQueue } from "./data/access.js";

const TASKS_FIXTURE = `# team-proj tasks

## Active

- [ ] alpha item

## Queue

- [ ] beta item

## Done

`;

const FINDINGS_FIXTURE = `# team-proj Findings

## 2026-08-01

- Task routing resolves the owning store before touching files
`;

describe("multi-store data layer", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenDir: string;
  let teamDir: string;
  const origFedPaths = process.env.PHREN_FEDERATION_PATHS;

  beforeEach(() => {
    tmp = makeTempDir("multi-store-data-test-");
    phrenDir = path.join(tmp.path, ".phren");
    teamDir = path.join(tmp.path, "team-store");
    fs.mkdirSync(phrenDir, { recursive: true });
    fs.mkdirSync(teamDir, { recursive: true });
    delete process.env.PHREN_FEDERATION_PATHS;

    fs.mkdirSync(path.join(phrenDir, "personal-proj"), { recursive: true });
    fs.writeFileSync(path.join(phrenDir, "personal-proj", "FINDINGS.md"), "# personal-proj Findings\n");

    fs.mkdirSync(path.join(teamDir, "team-proj"), { recursive: true });
    fs.writeFileSync(path.join(teamDir, "team-proj", "tasks.md"), TASKS_FIXTURE);
    fs.writeFileSync(path.join(teamDir, "team-proj", "FINDINGS.md"), FINDINGS_FIXTURE);

    const registry: StoreRegistry = {
      version: 1,
      stores: [
        { id: "aaa11111", name: "personal", path: phrenDir, role: "primary", sync: "managed-git" },
        { id: "bbb22222", name: "work-shared", path: teamDir, role: "team", sync: "managed-git" },
      ],
    };
    writeStoreRegistry(phrenDir, registry);
  });

  afterEach(() => {
    if (origFedPaths !== undefined) {
      process.env.PHREN_FEDERATION_PATHS = origFedPaths;
    } else {
      delete process.env.PHREN_FEDERATION_PATHS;
    }
    tmp.cleanup();
  });

  describe("ensureProject", () => {
    it("resolves a secondary-store project to that store's directory", () => {
      const result = ensureProject(phrenDir, "team-proj");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toBe(path.join(teamDir, "team-proj"));
    });

    it("still resolves a primary-store project to the primary directory", () => {
      const result = ensureProject(phrenDir, "personal-proj");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toBe(path.join(phrenDir, "personal-proj"));
    });

    it("prefers the primary store when the same name exists in both", () => {
      fs.mkdirSync(path.join(phrenDir, "team-proj"), { recursive: true });
      const result = ensureProject(phrenDir, "team-proj");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toBe(path.join(phrenDir, "team-proj"));
    });

    it("keeps the original error for an unknown project", () => {
      const result = ensureProject(phrenDir, "nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(PhrenError.PROJECT_NOT_FOUND);
        expect(result.error).toContain('No project "nonexistent" found');
      }
    });

    it("surfaces the disambiguation error when a project is in multiple secondary stores", () => {
      const otherDir = path.join(tmp.path, "other-store");
      fs.mkdirSync(path.join(otherDir, "team-proj"), { recursive: true });
      const registry: StoreRegistry = {
        version: 1,
        stores: [
          { id: "aaa11111", name: "personal", path: phrenDir, role: "primary", sync: "managed-git" },
          { id: "bbb22222", name: "work-shared", path: teamDir, role: "team", sync: "managed-git" },
          { id: "ccc33333", name: "other", path: otherDir, role: "team", sync: "managed-git" },
        ],
      };
      writeStoreRegistry(phrenDir, registry);

      const result = ensureProject(phrenDir, "team-proj");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(PhrenError.VALIDATION_ERROR);
        expect(result.error).toContain("multiple stores");
      }
    });
  });

  describe("tasks", () => {
    it("canonicalTaskFilePath points at the secondary store's file", () => {
      expect(canonicalTaskFilePath(phrenDir, "team-proj")).toBe(
        path.join(teamDir, "team-proj", "tasks.md"),
      );
    });

    it("reads a secondary-store project's tasks", () => {
      const result = readTasks(phrenDir, "team-proj");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.items.Active.map((i) => i.line)).toEqual(["alpha item"]);
        expect(result.data.items.Queue.map((i) => i.line)).toEqual(["beta item"]);
      }
    });

    it("adds a task to the secondary store without scaffolding a primary-store copy", () => {
      const result = addTask(phrenDir, "team-proj", "gamma item");
      expect(result.ok).toBe(true);

      const content = fs.readFileSync(path.join(teamDir, "team-proj", "tasks.md"), "utf8");
      expect(content).toContain("gamma item");
      expect(fs.existsSync(path.join(phrenDir, "team-proj"))).toBe(false);
    });

    it("completes and removes tasks in the secondary store", () => {
      const completed = completeTask(phrenDir, "team-proj", "alpha item");
      expect(completed.ok).toBe(true);

      const removed = removeTask(phrenDir, "team-proj", "beta item");
      expect(removed.ok).toBe(true);

      const content = fs.readFileSync(path.join(teamDir, "team-proj", "tasks.md"), "utf8");
      expect(content).toContain("- [x] alpha item");
      expect(content).not.toContain("beta item");
      expect(fs.existsSync(path.join(phrenDir, "team-proj"))).toBe(false);
    });

    it("errors on an unknown project without scaffolding a directory", () => {
      const result = removeTask(phrenDir, "no-such-proj", "anything");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(PhrenError.PROJECT_NOT_FOUND);
      expect(fs.existsSync(path.join(phrenDir, "no-such-proj"))).toBe(false);
    });
  });

  describe("findings", () => {
    it("reads findings from the secondary store", () => {
      const result = readFindings(phrenDir, "team-proj");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.map((f) => f.text)).toContain(
          "Task routing resolves the owning store before touching files",
        );
      }
    });

    it("adds a finding to the secondary store's FINDINGS.md", () => {
      const result = addFinding(phrenDir, "team-proj", "The archive chain resolves one tap at a time on iOS");
      expect(result.ok).toBe(true);

      const content = fs.readFileSync(path.join(teamDir, "team-proj", "FINDINGS.md"), "utf8");
      expect(content).toContain("archive chain resolves one tap");
      expect(fs.existsSync(path.join(phrenDir, "team-proj"))).toBe(false);
    });

    it("removes a finding from the secondary store (escape guard accepts secondary paths)", () => {
      const result = removeFinding(phrenDir, "team-proj", "Task routing resolves the owning store");
      expect(result.ok).toBe(true);

      const content = fs.readFileSync(path.join(teamDir, "team-proj", "FINDINGS.md"), "utf8");
      expect(content).not.toContain("Task routing resolves the owning store");
    });
  });

  describe("storeAwareProjectPath", () => {
    it("builds paths under the owning secondary store", () => {
      expect(storeAwareProjectPath(phrenDir, "team-proj")).toBe(path.join(teamDir, "team-proj"));
      expect(storeAwareProjectPath(phrenDir, "team-proj", "reference", "topics", "general.md")).toBe(
        path.join(teamDir, "team-proj", "reference", "topics", "general.md"),
      );
    });

    it("keeps primary-store paths for primary and unknown projects", () => {
      expect(storeAwareProjectPath(phrenDir, "personal-proj")).toBe(path.join(phrenDir, "personal-proj"));
      expect(storeAwareProjectPath(phrenDir, "no-such-proj")).toBe(path.join(phrenDir, "no-such-proj"));
    });

    it("rejects traversal the same as safeProjectPath", () => {
      expect(storeAwareProjectPath(phrenDir, "team-proj", "..", "..", "escape.md")).toBeNull();
    });
  });

  describe("review queue", () => {
    it("appends queue entries into the secondary store", () => {
      const result = appendReviewQueue(phrenDir, "team-proj", "Review", ["Candidate from capture"]);
      expect(result.ok).toBe(true);

      const queueFile = path.join(teamDir, "team-proj", "review.md");
      expect(fs.existsSync(queueFile)).toBe(true);
      expect(fs.readFileSync(queueFile, "utf8")).toContain("Candidate from capture");
      expect(fs.existsSync(path.join(phrenDir, "team-proj"))).toBe(false);
    });

    it("reads the secondary store's review.md", () => {
      fs.writeFileSync(
        path.join(teamDir, "team-proj", "review.md"),
        "# team-proj Review\n\n## Review\n\n- [2026-08-01] Candidate finding from capture\n",
      );
      const result = readReviewQueue(phrenDir, "team-proj");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].text).toContain("Candidate finding from capture");
      }
    });
  });
});
