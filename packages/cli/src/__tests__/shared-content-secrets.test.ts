import { describe, it, expect, afterEach } from "vitest";
import {
  addFindingToFile,
} from "../shared/content.js";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";

// Test fixtures are constructed at runtime so static secret scanners don't
// flag this file. These are not real credentials — they are synthetic strings
// that match the detector regexes and nothing else.
const FAKE_AWS_KEY    = "AKIA" + "TESTFAKEKEY00001";                          // matches /AKIA[0-9A-Z]{16}/
// matches JWT three-part pattern
// matches Stripe secret key pattern
let tmpDir: string;
let tmpCleanup: (() => void) | undefined;

function makePhren(): string {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("phren-secrets-test-"));
  return tmpDir;
}

function makeProject(phrenDir: string, name: string, files: Record<string, string>): void {
  const dir = path.join(phrenDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
}

afterEach(() => {
  delete process.env.PHREN_ACTOR;
  if (tmpCleanup) {
    tmpCleanup();
    tmpCleanup = undefined;
  }
});

describe("addFindingToFile rejects secrets", () => {
  it("returns VALIDATION_ERROR when finding contains an AWS key", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "myproj", { "summary.md": "# myproj\n" });

    const result = addFindingToFile(phren, "myproj", `Use ${FAKE_AWS_KEY} for the API`);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("Rejected: finding appears to contain a secret (AWS access key)");
    expect(result.ok === false && result.code).toBe("VALIDATION_ERROR");
  });
});
