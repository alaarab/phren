import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTarball, rehRoot, rehStatus, stopReh } from "./reh.js";

const ORIGINAL_REH = process.env.PHREN_DESKTOP_REH;
const ORIGINAL_TARBALL = process.env.PHREN_REH_TARBALL;
const ORIGINAL_TIMEOUT = process.env.PHREN_REH_START_TIMEOUT_MS;

let work: string;
let runsLog: string;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "phren-reh-"));
  process.env.PHREN_DESKTOP_REH = path.join(work, "reh");
  runsLog = path.join(work, "runs.log");
});

afterEach(() => {
  stopReh();
  restore("PHREN_DESKTOP_REH", ORIGINAL_REH);
  restore("PHREN_REH_TARBALL", ORIGINAL_TARBALL);
  restore("PHREN_REH_START_TIMEOUT_MS", ORIGINAL_TIMEOUT);
  rmSync(work, { recursive: true, force: true });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** A tarball holding the inner folder "vscode-reh-test-1.0.0" whose
 *  bin/code-server-oss runs `body`. reh.ts derives the version from the tarball
 *  basename, so that carries a platform-like "-<os>-<arch>-" segment. */
function buildTarball(name: string, body: string): string {
  const parent = mkdtempSync(path.join(work, "pack-"));
  const folder = path.join(parent, "vscode-reh-test-1.0.0");
  mkdirSync(path.join(folder, "bin"), { recursive: true });
  writeFileSync(path.join(folder, "product.json"), "{}");
  const launcher = path.join(folder, "bin", "code-server-oss");
  writeFileSync(launcher, `#!/bin/sh\n${body}\n`);
  chmodSync(launcher, 0o755);
  const tarball = path.join(work, name);
  execFileSync("tar", ["-czf", tarball, "-C", parent, "vscode-reh-test-1.0.0"]);
  return tarball;
}

const listeningBody = () =>
  `echo run >> "${runsLog}"\necho "Extension host agent listening on 54321"\nexec sleep 30`;

describe("findTarball", () => {
  it("returns PHREN_REH_TARBALL when it exists", () => {
    const tarball = buildTarball("vscode-reh-test-any-1.0.0.tar.gz", "exit 0");
    process.env.PHREN_REH_TARBALL = tarball;
    expect(findTarball()).toBe(tarball);
  });

  it("returns undefined when the configured tarball is missing", () => {
    process.env.PHREN_REH_TARBALL = path.join(work, "missing.tar.gz");
    expect(findTarball()).toBeUndefined();
  });
});

describe("rehStatus", () => {
  it("unpacks the tarball, starts the server and reports authority, token and version", async () => {
    process.env.PHREN_REH_TARBALL = buildTarball("vscode-reh-test-any-1.0.0.tar.gz", listeningBody());

    const status = await rehStatus();

    expect(status).toEqual({
      available: true,
      authority: "localhost:54321",
      connectionToken: expect.stringMatching(/^[0-9a-f]{48}$/),
      version: "1.0.0",
    });
    expect(existsSync(path.join(rehRoot(), "vscode-reh-test-any-1.0.0", "product.json"))).toBe(true);
    const tokenFile = path.join(rehRoot(), "connection-token");
    expect(readFileSync(tokenFile, "utf8")).toBe(status.connectionToken);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });

  it("returns the same status on a second call without starting a second server", async () => {
    process.env.PHREN_REH_TARBALL = buildTarball("vscode-reh-test-any-1.0.0.tar.gz", listeningBody());

    const first = await rehStatus();
    const second = await rehStatus();

    expect(second).toBe(first);
    expect(readFileSync(runsLog, "utf8")).toBe("run\n");
  });

  it("reports unavailable when the launcher exits immediately", async () => {
    process.env.PHREN_REH_TARBALL = buildTarball("vscode-reh-exit-any-1.0.0.tar.gz", "exit 3");

    const status = await rehStatus();

    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/exited/i);
    expect(status.reason).toContain("3");
  });

  it("kills a server that never reports listening after the start timeout", async () => {
    process.env.PHREN_REH_START_TIMEOUT_MS = "600";
    const body = `trap 'echo term >> "${runsLog}"' TERM\necho run >> "${runsLog}"\nwhile true; do sleep 0.5; done`;
    process.env.PHREN_REH_TARBALL = buildTarball("vscode-reh-test-any-1.0.0.tar.gz", body);

    const status = await rehStatus();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/did not start/i);

    let log = "";
    for (let i = 0; i < 60; i++) {
      try { log = readFileSync(runsLog, "utf8"); } catch { log = ""; }
      if (log.includes("term")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(log).toContain("term");
  });
});
