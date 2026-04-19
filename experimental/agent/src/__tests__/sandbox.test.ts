import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { validatePath, isPathInSandbox, checkSensitivePath } from "../permissions/sandbox.js";

describe("validatePath", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allows path inside project root", () => {
    const filePath = path.join(tmpDir, "src", "index.ts");
    const result = validatePath(filePath, tmpDir, []);
    expect(result.ok).toBe(true);
  });

  it("rejects path outside project root", () => {
    const result = validatePath("/etc/passwd", tmpDir, []);
    expect(result.ok).toBe(false);
  });

  it("allows path in allowed paths list", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "allowed-"));
    try {
      const result = validatePath(path.join(otherDir, "file.ts"), tmpDir, [otherDir]);
      expect(result.ok).toBe(true);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("resolves relative paths against project root", () => {
    const result = validatePath("src/index.ts", tmpDir, []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe(path.resolve(tmpDir, "src/index.ts"));
    }
  });

  it("rejects relative path that escapes via ..", () => {
    const result = validatePath("../../../../etc/passwd", tmpDir, []);
    expect(result.ok).toBe(false);
  });

  it("resolves symlinks to detect escape", () => {
    // Create a symlink inside tmpDir that points outside
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret");
    const symlinkPath = path.join(tmpDir, "escape");
    fs.symlinkSync(outsideFile, symlinkPath);

    try {
      const result = validatePath(symlinkPath, tmpDir, []);
      expect(result.ok).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("resolves tilde to home directory", () => {
    const home = os.homedir();
    const result = validatePath("~/some-file.ts", home, []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toContain(home);
    }
  });
});

describe("isPathInSandbox", () => {
  it("returns true for path inside root", () => {
    expect(isPathInSandbox("/project/src/file.ts", "/project", [])).toBe(true);
  });

  it("returns true for the root path itself", () => {
    expect(isPathInSandbox("/project", "/project", [])).toBe(true);
  });

  it("returns false for path outside root and allowed", () => {
    expect(isPathInSandbox("/etc/config", "/project", [])).toBe(false);
  });

  it("returns true for path inside allowed paths", () => {
    expect(isPathInSandbox("/home/user/.phren/data", "/project", ["/home/user/.phren"])).toBe(true);
  });
});

describe("checkSensitivePath", () => {
  it("flags .ssh paths", () => {
    expect(checkSensitivePath("/home/user/.ssh/id_rsa").sensitive).toBe(true);
  });

  it("flags .aws paths", () => {
    expect(checkSensitivePath("/home/user/.aws/credentials").sensitive).toBe(true);
  });

  it("flags .env files", () => {
    expect(checkSensitivePath("/project/.env").sensitive).toBe(true);
  });

  it("flags .pem files", () => {
    expect(checkSensitivePath("/certs/server.pem").sensitive).toBe(true);
  });

  it("flags credentials.json", () => {
    expect(checkSensitivePath("/project/credentials.json").sensitive).toBe(true);
  });

  it("flags secrets.yaml", () => {
    expect(checkSensitivePath("/config/secrets.yaml").sensitive).toBe(true);
  });

  it("flags /etc/shadow", () => {
    expect(checkSensitivePath("/etc/shadow").sensitive).toBe(true);
  });

  it("does not flag normal files", () => {
    expect(checkSensitivePath("/project/src/index.ts").sensitive).toBe(false);
  });

  it("does not flag package.json", () => {
    expect(checkSensitivePath("/project/package.json").sensitive).toBe(false);
  });
});
