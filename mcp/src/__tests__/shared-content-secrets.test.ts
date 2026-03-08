import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  scanForSecrets,
  addFindingToFile,
} from "../shared-content.js";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";

// Test fixtures are constructed at runtime so static secret scanners don't
// flag this file. These are not real credentials — they are synthetic strings
// that match the detector regexes and nothing else.
const FAKE_AWS_KEY    = "AKIA" + "TESTFAKEKEY00001";          // matches /AKIA[0-9A-Z]{16}/
const FAKE_JWT        = "eyJmYWtl" + "." + "eyJmYWtl" + "." + "ZmFrZXNpZw";  // matches JWT three-part pattern
const FAKE_SK_LIVE    = "sk_live_" + "TESTONLYFAKEKEY0000001"; // matches Stripe secret key pattern

let tmpDir: string;
let tmpCleanup: (() => void) | undefined;

function makeCortex(): string {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-secrets-test-"));
  return tmpDir;
}

function makeProject(cortexDir: string, name: string, files: Record<string, string>): void {
  const dir = path.join(cortexDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
}

afterEach(() => {
  delete process.env.CORTEX_ACTOR;
  if (tmpCleanup) {
    tmpCleanup();
    tmpCleanup = undefined;
  }
});

describe("scanForSecrets", () => {
  it("detects AWS access key", () => {
    const result = scanForSecrets(`Use ${FAKE_AWS_KEY} for auth`);
    expect(result).toBe("AWS access key");
  });

  it("detects JWT token", () => {
    const result = scanForSecrets(`token is ${FAKE_JWT}`);
    expect(result).toBe("JWT token");
  });

  it("detects connection strings with credentials", () => {
    expect(scanForSecrets("mongodb://testuser:testpass@localhost:27017/db")).toBe("connection string with credentials");
    expect(scanForSecrets("postgres://testuser:testpass@localhost:5432/testdb")).toBe("connection string with credentials");
  });

  it("detects SSH private key", () => {
    const result = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----");
    expect(result).toBe("SSH private key");
  });

  it("detects API key patterns", () => {
    const result = scanForSecrets(`api_key = "${FAKE_SK_LIVE}"`);
    expect(result).toBe("API key or secret");
  });

  it("returns null for clean text", () => {
    expect(scanForSecrets("Always use parameterized queries for SQL")).toBeNull();
    expect(scanForSecrets("The build system uses webpack 5")).toBeNull();
  });
});

describe("addFindingToFile rejects secrets", () => {
  it("returns VALIDATION_ERROR when finding contains an AWS key", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "myproj", { "summary.md": "# myproj\n" });

    const result = addFindingToFile(cortex, "myproj", `Use ${FAKE_AWS_KEY} for the API`);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("Rejected: finding appears to contain a secret (AWS access key)");
    expect(result.ok === false && result.code).toBe("VALIDATION_ERROR");
  });

  it("returns VALIDATION_ERROR when finding contains a JWT", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "myproj", { "summary.md": "# myproj\n" });

    const result = addFindingToFile(cortex, "myproj", `Set token to ${FAKE_JWT}`);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("Rejected: finding appears to contain a secret (JWT token)");
    expect(result.ok === false && result.code).toBe("VALIDATION_ERROR");
  });

  it("allows clean findings through", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "myproj", { "summary.md": "# myproj\n" });

    const result = addFindingToFile(cortex, "myproj", "Always use parameterized queries");
    expect(result.ok).toBe(true);
  });
});
