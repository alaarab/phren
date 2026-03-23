import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "./test-helpers.js";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { resetPhrenDotEnvBootstrapForTests } from "./phren-dotenv.js";

// We test normalizeManifest indirectly through readRootManifest since it's not exported.
import {
  readRootManifest,
  writeRootManifest,
  ROOT_MANIFEST_FILENAME,
} from "./phren-paths.js";

describe("cross-platform path normalization", () => {
  let tmp: { path: string; cleanup: () => void };
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  const origPhrenPath = process.env.PHREN_PATH;

  beforeEach(() => {
    tmp = makeTempDir("phren-paths-");
    process.env.HOME = tmp.path;
    process.env.USERPROFILE = tmp.path;
    delete process.env.PHREN_PATH;
    resetPhrenDotEnvBootstrapForTests();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    if (origPhrenPath !== undefined) process.env.PHREN_PATH = origPhrenPath;
    else delete process.env.PHREN_PATH;
    tmp.cleanup();
  });

  it("normalizes Windows backslashes in workspaceRoot on non-Windows platforms", () => {
    // Create a manifest with a Windows-style path
    const phrenDir = path.join(tmp.path, ".phren");
    fs.mkdirSync(phrenDir, { recursive: true });

    // Also create the workspace target directory so path.resolve works
    const targetDir = path.join(tmp.path, "Users", "foo", "projects", "myapp");
    fs.mkdirSync(targetDir, { recursive: true });

    // Write a raw YAML manifest with Windows backslash path
    const windowsPath = `${tmp.path}\\Users\\foo\\projects\\myapp`;
    const manifestContent = yaml.dump({
      version: 1,
      installMode: "project-local",
      syncMode: "managed-git",
      workspaceRoot: windowsPath,
      primaryProject: "myapp",
    });

    fs.writeFileSync(path.join(phrenDir, ROOT_MANIFEST_FILENAME), manifestContent);

    // Create the project directory so validation passes
    const projectDir = path.join(phrenDir, "myapp");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), "# Findings\n");

    const manifest = readRootManifest(phrenDir);

    // On Linux/macOS, workspaceRoot should have forward slashes only
    if (process.platform !== "win32") {
      expect(manifest).not.toBeNull();
      expect(manifest!.workspaceRoot).toBeDefined();
      expect(manifest!.workspaceRoot!).not.toContain("\\");
      // Should resolve to a valid forward-slash path
      expect(manifest!.workspaceRoot!).toContain("/Users/foo/projects/myapp");
    }
  });

  it("reads a shared-mode manifest with no workspaceRoot without issue", () => {
    const phrenDir = path.join(tmp.path, ".phren");
    fs.mkdirSync(phrenDir, { recursive: true });

    const manifestContent = yaml.dump({
      version: 1,
      installMode: "shared",
      syncMode: "managed-git",
    });
    fs.writeFileSync(path.join(phrenDir, ROOT_MANIFEST_FILENAME), manifestContent);

    const manifest = readRootManifest(phrenDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.installMode).toBe("shared");
    expect(manifest!.workspaceRoot).toBeUndefined();
  });

  it("preserves forward slashes in workspaceRoot on non-Windows", () => {
    const phrenDir = path.join(tmp.path, ".phren");
    fs.mkdirSync(phrenDir, { recursive: true });

    const targetDir = path.join(tmp.path, "home", "user", "project");
    fs.mkdirSync(targetDir, { recursive: true });

    const projectDir = path.join(phrenDir, "myproject");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), "# Findings\n");

    const forwardPath = `${tmp.path}/home/user/project`;
    const manifestContent = yaml.dump({
      version: 1,
      installMode: "project-local",
      syncMode: "managed-git",
      workspaceRoot: forwardPath,
      primaryProject: "myproject",
    });
    fs.writeFileSync(path.join(phrenDir, ROOT_MANIFEST_FILENAME), manifestContent);

    const manifest = readRootManifest(phrenDir);
    if (process.platform !== "win32") {
      expect(manifest).not.toBeNull();
      expect(manifest!.workspaceRoot).toBeDefined();
      expect(manifest!.workspaceRoot!).not.toContain("\\");
    }
  });
});

describe("isValidProjectName (via webview validation)", () => {
  // We import the server-side isValidProjectName to verify it rejects traversal
  // The webview mirrors this logic inline.
  let isValidProjectName: (name: string) => boolean;

  beforeEach(async () => {
    const utils = await import("./utils.js");
    isValidProjectName = utils.isValidProjectName;
  });

  it("rejects path traversal attempts", () => {
    expect(isValidProjectName("../../../etc/passwd")).toBe(false);
  });

  it("rejects names with forward slashes", () => {
    expect(isValidProjectName("foo/bar")).toBe(false);
  });

  it("rejects names with backslashes", () => {
    expect(isValidProjectName("foo\\bar")).toBe(false);
  });

  it("rejects dot-only names", () => {
    expect(isValidProjectName(".")).toBe(false);
    expect(isValidProjectName("..")).toBe(false);
  });

  it("rejects names starting with dot", () => {
    expect(isValidProjectName(".hidden")).toBe(false);
  });

  it("accepts valid project names", () => {
    expect(isValidProjectName("my-project")).toBe(true);
    expect(isValidProjectName("project123")).toBe(true);
    expect(isValidProjectName("a")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isValidProjectName("")).toBe(false);
  });
});
