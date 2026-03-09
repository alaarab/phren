import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
}));

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: mockExistsSync,
  };
});

vi.mock("child_process", () => ({
  execFileSync: mockExecFileSync,
}));

import { runCortexUpdate } from "./update.js";
import { PACKAGE_SPEC } from "./package-metadata.js";

function npmExec(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

describe("runCortexUpdate", () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates local repo when package root is a git checkout", async () => {
    mockExistsSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith(".git")) return true;
      if (String(filePath).endsWith("package.json")) return true;
      return false;
    });

    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") return " M mcp/src/update.ts ";
      if (cmd === "git" && args[0] === "pull") return "Already up to date.";
      if (cmd === npmExec() && args[0] === "install") return "";
      if (cmd === npmExec() && args[0] === "run" && args[1] === "build") return "";
      if (cmd === process.execPath && /mcp[\\/]+dist[\\/]+index\.js$/.test(String(args[0])) && args[1] === "--health") return "";
      throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await runCortexUpdate();

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Updated local cortex repo at");
    expect(result.message).toContain("(Already up to date.)");
    expect(result.message).toContain("Run `cortex update --refresh-starter`");
    expect(result.message).toContain("Rebuilt and verified CLI health.");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["pull", "--rebase", "--autostash"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      npmExec(),
      ["install"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      npmExec(),
      ["run", "build"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/mcp[\\/]dist[\\/]index\.js$/), "--health"],
      expect.objectContaining({ encoding: "utf8" })
    );
  });

  it("returns a local update failure message when git pull fails", async () => {
    mockExistsSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith(".git")) return true;
      if (String(filePath).endsWith("package.json")) return true;
      return false;
    });

    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") return "";
      if (cmd === "git" && args[0] === "pull") throw new Error("pull failed");
      throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await runCortexUpdate();

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Local repo update failed: pull failed");
    expect(
      mockExecFileSync.mock.calls.some(
        (call: unknown[]) => call[0] === npmExec() && Array.isArray(call[1]) && call[1][0] === "install"
      )
    ).toBe(false);
  });

  it("returns a rebuild failure message when build or smoke-check fails after pull", async () => {
    mockExistsSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith(".git")) return true;
      if (String(filePath).endsWith("package.json")) return true;
      return false;
    });

    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") return "";
      if (cmd === "git" && args[0] === "pull") return "Fast-forward";
      if (cmd === npmExec() && args[0] === "install") return "";
      if (cmd === npmExec() && args[0] === "run" && args[1] === "build") throw new Error("build failed");
      throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await runCortexUpdate();

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Local repo updated but rebuild/health check failed: build failed");
  });

  it("falls back to global npm update when git checkout is unavailable", async () => {
    mockExistsSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith(".git")) return false;
      if (String(filePath).endsWith("package.json")) return true;
      return false;
    });
    mockExecFileSync.mockReturnValue("");

    const result = await runCortexUpdate();

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Updated cortex via npm global install (@latest) and verified the package is installed.");
    expect(result.message).toContain("Run `cortex update --refresh-starter`");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      npmExec(),
      ["install", "-g", "@alaarab/cortex@latest"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      npmExec(),
      ["list", "-g", "@alaarab/cortex", "--depth=0"],
      expect.objectContaining({ encoding: "utf8" })
    );
  });

  it("returns a global update failure message when npm install fails", async () => {
    mockExistsSync.mockImplementation((filePath: fs.PathLike) => {
      if (String(filePath).endsWith(".git")) return false;
      if (String(filePath).endsWith("package.json")) return true;
      return false;
    });
    mockExecFileSync.mockImplementation(() => {
      throw new Error("network down");
    });

    const result = await runCortexUpdate();

    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      `Global update failed: network down. Try manually: npm install -g ${PACKAGE_SPEC}`
    );
  });

  it("can refresh starter assets as part of update", async () => {
    mockExistsSync.mockImplementation((filePath: fs.PathLike) => {
      const value = String(filePath);
      if (value.endsWith(".git")) return true;
      if (value.endsWith("package.json")) return true;
      if (value.includes(path.join(".runtime", "starter-updates"))) return false;
      return false;
    });

    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") return "";
      if (cmd === "git" && args[0] === "pull") return "Fast-forward";
      if (cmd === npmExec() && args[0] === "install") return "";
      if (cmd === npmExec() && args[0] === "run" && args[1] === "build") return "";
      if (cmd === process.execPath && /mcp[\\/]+dist[\\/]+index\.js$/.test(String(args[0])) && args[1] === "--health") return "";
      if (cmd === process.execPath && /mcp[\\/]+dist[\\/]+index\.js$/.test(String(args[0])) && args[1] === "init") return "";
      throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await runCortexUpdate({ refreshStarter: true });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Refreshed starter assets.");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/mcp[\\/]dist[\\/]index\.js$/), "init", "--apply-starter-update", "-y"],
      expect.objectContaining({ encoding: "utf8" })
    );
  });
});
