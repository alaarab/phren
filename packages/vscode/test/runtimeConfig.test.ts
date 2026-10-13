import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRuntimePaths } from "../src/runtimeConfig";

// checkRuntimePaths only touches the filesystem, so it is exercised against a
// real temp directory rather than mocked stats: the file-vs-directory and
// missing-path cases are exactly what the diagnosis turns into user text.
describe("checkRuntimePaths", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-runtime-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeServer(): string {
    const serverPath = path.join(dir, "index.js");
    fs.writeFileSync(serverPath, "");
    return serverPath;
  }

  function makeStore(): string {
    const storePath = path.join(dir, "store");
    fs.mkdirSync(storePath);
    return storePath;
  }

  it("passes when the MCP server file and the store directory both exist", () => {
    const result = checkRuntimePaths({ mcpServerPath: writeServer(), storePath: makeStore(), nodePath: "node" });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.message).toBe("");
  });

  it("names the missing MCP server file and the path it looked at", () => {
    const serverPath = path.join(dir, "missing.js");
    const result = checkRuntimePaths({ mcpServerPath: serverPath, storePath: makeStore(), nodePath: "node" });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["mcpServer"]);
    expect(result.message).toContain(serverPath);
  });

  it("says auto-detection found nothing when no server path was configured", () => {
    const result = checkRuntimePaths({ mcpServerPath: undefined, storePath: makeStore(), nodePath: "node" });
    expect(result.missing).toEqual(["mcpServer"]);
    expect(result.message).toMatch(/auto-detection found none/);
  });

  it("names the missing store directory when the server file exists", () => {
    const storePath = path.join(dir, "absent-store");
    const result = checkRuntimePaths({ mcpServerPath: writeServer(), storePath, nodePath: "node" });
    expect(result.missing).toEqual(["store"]);
    expect(result.message).toContain(storePath);
  });

  it("reports both missing paths and says the lookup was on the workspace side when remote", () => {
    const result = checkRuntimePaths(
      { mcpServerPath: path.join(dir, "missing.js"), storePath: path.join(dir, "missing-store"), nodePath: "node" },
      { remote: true },
    );
    expect(result.missing).toEqual(["mcpServer", "store"]);
    expect(result.message).toMatch(/workspace side/);
  });
});
