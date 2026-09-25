import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { autoArchiveToReference } from "../content/archive.js";
import { makeTempDir, } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";

describe("content-archive", () => {
  describe("autoArchiveToReference", () => {
    let tmpRoot: string;
    let tmpCleanup: () => void;

    beforeEach(() => {
      ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("phren-archive-test-"));
    });

    afterEach(() => {
      tmpCleanup();
    });

    it("returns ok(0) when FINDINGS.md does not exist", () => {
      const project = "no-findings";
      fs.mkdirSync(path.join(tmpRoot, project), { recursive: true });
      const result = autoArchiveToReference(tmpRoot, project, 10);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toBe(0);
    });

    it("returns error for invalid or missing projects", () => {
      expect(autoArchiveToReference(tmpRoot, "../escape", 10).ok).toBe(false);
      expect(autoArchiveToReference(tmpRoot, "ghost-project", 10).ok).toBe(false);
    });
  });
});
