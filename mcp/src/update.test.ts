import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";

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
      if (cmd === "npm" && args[0] === "install") return "";
      throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
    });

    const result = await runCortexUpdate();

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Updated local cortex repo at");
    expect(result.message).toContain("(Already up to date.)");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["pull", "--rebase", "--autostash"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "npm",
      ["install"],
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
        (call: unknown[]) => call[0] === "npm" && Array.isArray(call[1]) && call[1][0] === "install"
      )
    ).toBe(false);
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
    expect(result.message).toBe("Updated cortex via npm global install (@latest).");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@alaarab/cortex@latest"],
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
      "Global update failed: network down. Try manually: npm install -g @alaarab/cortex@latest"
    );
  });
});
