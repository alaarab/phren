import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildPhrenContext } from "../memory/context.js";

/**
 * Project detection must match the CLI's own resolution: the store writes
 * `phren.project.yaml` with a `sourcePath:` key (NOT `project.yaml` with
 * `source:`, which a previous hand-rolled loop looked for).
 */
describe("buildPhrenContext project detection", () => {
  let storeDir: string;
  let sourceDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  const savedPhrenPath = process.env.PHREN_PATH;

  beforeEach(() => {
    storeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-store-")));
    sourceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-src-")));
    // findPhrenPath only accepts a PHREN_PATH that looks like a real store root.
    fs.writeFileSync(
      path.join(storeDir, "phren.root.yaml"),
      "version: 1\ninstallMode: shared\nsyncMode: managed-git\n",
    );
    const projectDir = path.join(storeDir, "myproj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), "# Findings\n");
    fs.writeFileSync(
      path.join(projectDir, "phren.project.yaml"),
      `sourcePath: ${sourceDir}\n`,
    );
    process.env.PHREN_PATH = storeDir;
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    if (savedPhrenPath === undefined) delete process.env.PHREN_PATH;
    else process.env.PHREN_PATH = savedPhrenPath;
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  });

  function mockCwd(dir: string): void {
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
  }

  it("detects the project when cwd is the registered sourcePath", async () => {
    mockCwd(sourceDir);
    const ctx = await buildPhrenContext();
    expect(ctx).not.toBeNull();
    expect(ctx?.project).toBe("myproj");
  });

  it("detects the project from a subdirectory of the sourcePath", async () => {
    const sub = path.join(sourceDir, "packages", "web");
    fs.mkdirSync(sub, { recursive: true });
    mockCwd(sub);
    const ctx = await buildPhrenContext();
    expect(ctx?.project).toBe("myproj");
  });

  it("returns null project for an unrelated cwd", async () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-other-")));
    try {
      mockCwd(elsewhere);
      const ctx = await buildPhrenContext();
      expect(ctx?.project ?? null).toBeNull();
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("honors an explicit project override without detection", async () => {
    mockCwd(sourceDir);
    const ctx = await buildPhrenContext("override-proj");
    expect(ctx?.project).toBe("override-proj");
  });

  it("prefers the longest matching sourcePath for nested projects", async () => {
    const nestedSource = path.join(sourceDir, "nested");
    fs.mkdirSync(nestedSource, { recursive: true });
    const nestedDir = path.join(storeDir, "nestedproj");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "FINDINGS.md"), "# Findings\n");
    fs.writeFileSync(
      path.join(nestedDir, "phren.project.yaml"),
      `sourcePath: ${nestedSource}\n`,
    );
    mockCwd(nestedSource);
    const ctx = await buildPhrenContext();
    expect(ctx?.project).toBe("nestedproj");
  });
});
