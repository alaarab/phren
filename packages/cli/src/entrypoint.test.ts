import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTopLevelInvocation } from "./entrypoint.js";

const tempDirs: string[] = [];

function makePhrenRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-root-"));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "phren.root.yaml"),
    "version: 1\ninstallMode: shared\nsyncMode: managed-git\n"
  );
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveTopLevelInvocation", () => {
  it("routes empty argv to interactive agent mode", () => {
    expect(resolveTopLevelInvocation([])).toEqual({ kind: "agent", argv: ["-i"] });
  });

  it("routes freeform input to the agent", () => {
    expect(resolveTopLevelInvocation(["fix", "the", "login", "bug"])).toEqual({
      kind: "agent",
      argv: ["fix", "the", "login", "bug"],
    });
  });

  it("routes legacy management commands to manage mode", () => {
    expect(resolveTopLevelInvocation(["search", "auth"])).toEqual({
      kind: "manage",
      argv: ["search", "auth"],
    });
  });

  it("routes manage and mem aliases to manage mode", () => {
    expect(resolveTopLevelInvocation(["manage", "task", "list"])).toEqual({
      kind: "manage",
      argv: ["task", "list"],
    });
    expect(resolveTopLevelInvocation(["mem", "config", "show"])).toEqual({
      kind: "manage",
      argv: ["config", "show"],
    });
  });

  it("routes explicit agent alias to agent mode", () => {
    expect(resolveTopLevelInvocation(["agent", "--provider", "codex", "-i"])).toEqual({
      kind: "agent",
      argv: ["--provider", "codex", "-i"],
    });
  });

  it("routes auth commands to agent mode", () => {
    expect(resolveTopLevelInvocation(["auth", "status"])).toEqual({
      kind: "agent",
      argv: ["auth", "status"],
    });
  });

  it("routes a phren root path to MCP mode", () => {
    const phrenRoot = makePhrenRoot();
    expect(resolveTopLevelInvocation([phrenRoot])).toEqual({
      kind: "mcp",
      phrenArg: phrenRoot,
    });
  });

  it("routes help and version flags to integrated top-level views", () => {
    expect(resolveTopLevelInvocation(["--help"])).toEqual({ kind: "help" });
    expect(resolveTopLevelInvocation(["--version"])).toEqual({ kind: "version" });
  });
});
