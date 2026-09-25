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
  it("routes empty argv to manage mode (interactive shell default)", () => {
    expect(resolveTopLevelInvocation([])).toEqual({ kind: "manage", argv: [] });
  });

  it.each([
    ["legacy management commands", ["search", "auth"]],
    ["unknown commands, for error handling", ["fix", "the", "login", "bug"]],
  ])("routes %s to manage mode", (_label, argv) => {
    expect(resolveTopLevelInvocation(argv)).toEqual({ kind: "manage", argv });
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

  it("routes --help with a topic the same way as help with a topic", () => {
    expect(resolveTopLevelInvocation(["--help", "all"])).toEqual({ kind: "manage", argv: ["--help", "all"] });
    expect(resolveTopLevelInvocation(["-h", "all"])).toEqual({ kind: "manage", argv: ["-h", "all"] });
    expect(resolveTopLevelInvocation(["help", "all"])).toEqual({ kind: "manage", argv: ["help", "all"] });
  });
});
