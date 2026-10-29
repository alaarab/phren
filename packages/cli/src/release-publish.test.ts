import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// scripts/release-publish.sh, run with a fake npm that answers `npm view` with a
// fixed text and records `npm publish`.
const script = path.resolve("scripts/release-publish.sh");
const dirs: string[] = [];

function run(viewOutput: string, viewExit = 0) {
  const dir = mkdtempSync(path.join(tmpdir(), "release-publish-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "view.json"), viewOutput);
  writeFileSync(path.join(dir, "npm"), [
    "#!/usr/bin/env bash",
    `if [ "$1" = view ]; then cat "${dir}/view.json"; exit ${viewExit}; fi`,
    `if [ "$1" = publish ]; then echo "$@" > "${dir}/published"; exit 0; fi`,
    "exit 2",
  ].join("\n"));
  chmodSync(path.join(dir, "npm"), 0o755);
  const result = spawnSync("bash", [script, "@phren/cli", "."], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, INPUT_VERSION: "1.2.3", GITHUB_SHA: "abc", GITHUB_STEP_SUMMARY: path.join(dir, "summary") },
  });
  let published: string | undefined;
  try { published = readFileSync(path.join(dir, "published"), "utf8"); } catch { published = undefined; }
  return { status: result.status, stderr: result.stderr, published };
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("release-publish.sh", () => {
  it("publishes a version npm answers E404 for", () => {
    const answer = JSON.stringify({ error: { code: "E404", summary: "No match found for version 1.2.3" } });
    const result = run(answer, 1);
    expect(result.status).toBe(0);
    expect(result.published).toContain("publish . --access public --provenance");
  });

  it("publishes when npm answers nothing", () => {
    expect(run("").published).toBeDefined();
  });

  it("fails on another npm error without publishing", () => {
    const result = run(JSON.stringify({ error: { code: "E500", summary: "registry down" } }), 1);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("npm view failed");
    expect(result.published).toBeUndefined();
  });

  it("skips a version already published from this commit", () => {
    const result = run(JSON.stringify({ version: "1.2.3", gitHead: "abc" }));
    expect(result.status).toBe(0);
    expect(result.published).toBeUndefined();
  });

  it("fails on a version published from another commit", () => {
    const result = run(JSON.stringify({ version: "1.2.3", gitHead: "def" }));
    expect(result.status).not.toBe(0);
    expect(result.published).toBeUndefined();
  });
});
