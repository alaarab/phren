import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  scanForSecrets,
  addFindingToFile,
} from "../shared-content.js";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";

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
    const result = scanForSecrets("Use AKIAIOSFODNN7EXAMPLE for auth");
    expect(result).toBe("AWS access key");
  });

  it("detects JWT token", () => {
    const result = scanForSecrets("token is eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
    expect(result).toBe("JWT token");
  });

  it("detects connection strings with credentials", () => {
    expect(scanForSecrets("mongodb://admin:password123@localhost:27017/db")).toBe("connection string with credentials");
    expect(scanForSecrets("postgres://user:secret@host:5432/mydb")).toBe("connection string with credentials");
  });

  it("detects SSH private key", () => {
    const result = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----");
    expect(result).toBe("SSH private key");
  });

  it("detects API key patterns", () => {
    const result = scanForSecrets('api_key = "sk_live_abcdefghijklmnopqrst"');
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

    const result = addFindingToFile(cortex, "myproj", "Use AKIAIOSFODNN7EXAMPLE for the API");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("Rejected: finding appears to contain a secret (AWS access key)");
    expect(result.ok === false && result.code).toBe("VALIDATION_ERROR");
  });

  it("returns VALIDATION_ERROR when finding contains a JWT", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "myproj", { "summary.md": "# myproj\n" });

    const result = addFindingToFile(cortex, "myproj", "Set token to eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
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
