import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTarball, nodeExtensionsEnabled, rehRoot, rehStatus, setNodeExtensionsEnabled, stopReh } from "./reh.js";

const ORIGINAL_REH = process.env.PHREN_DESKTOP_REH;
const ORIGINAL_TARBALL = process.env.PHREN_REH_TARBALL;
const ORIGINAL_TIMEOUT = process.env.PHREN_REH_START_TIMEOUT_MS;
const ORIGINAL_EXTENSIONS = process.env.PHREN_DESKTOP_EXTENSIONS;
const ORIGINAL_BRIDGE = process.env.PHREN_BRIDGE_HOME;
const PLANTED = ["PHREN_DESKTOP_TOKEN_FD", "PHREN_DESKTOP_TOKEN", "SSH_AUTH_SOCK", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "VSCODE_IPC_HOOK_CLI", "TMUX", "NODE_OPTIONS"] as const;
const ORIGINAL_PLANTED = Object.fromEntries(PLANTED.map((key) => [key, process.env[key]]));

let work: string;
let runsLog: string;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "phren-reh-"));
  process.env.PHREN_DESKTOP_REH = path.join(work, "reh");
  // Node extensions are opt-in; these tests exercise the host itself.
  process.env.PHREN_DESKTOP_EXTENSIONS = path.join(work, "extensions");
  mkdirSync(process.env.PHREN_DESKTOP_EXTENSIONS, { recursive: true });
  writeFileSync(path.join(process.env.PHREN_DESKTOP_EXTENSIONS, "node-extensions-enabled"), "on\n");
  runsLog = path.join(work, "runs.log");
});

afterEach(() => {
  stopReh();
  restore("PHREN_DESKTOP_REH", ORIGINAL_REH);
  restore("PHREN_REH_TARBALL", ORIGINAL_TARBALL);
  restore("PHREN_DESKTOP_EXTENSIONS", ORIGINAL_EXTENSIONS);
  restore("PHREN_REH_START_TIMEOUT_MS", ORIGINAL_TIMEOUT);
  restore("PHREN_BRIDGE_HOME", ORIGINAL_BRIDGE);
  for (const key of PLANTED) restore(key, ORIGINAL_PLANTED[key]);
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

// The remote extension host is a POSIX tarball with a shell launcher.
describe.skipIf(process.platform === "win32")("rehStatus", () => {
  it("unpacks the tarball, starts the server and reports authority, token and version", async () => {
    process.env.PHREN_REH_TARBALL = buildTarball("vscode-reh-test-any-1.0.0.tar.gz", listeningBody());

    const status = await rehStatus();

    expect(status).toEqual({
      available: true,
      authority: "localhost:54321",
      connectionToken: expect.stringMatching(/^[0-9a-f]{48}$/),
      version: "1.0.0",
      isolation: process.platform === "darwin" ? "sandbox" : "environment",
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

// What a Node extension inside the host can reach: the launcher stands in for
// the server and records what it sees, as an extension's code would.
describe.skipIf(process.platform === "win32")("extension host isolation", () => {
  let hook: Server | undefined;
  afterEach(() => { hook?.close(); hook = undefined; });

  it("starts the host with no desktop secrets in its environment, in its own HOME and TMPDIR", async () => {
    const planted: Record<(typeof PLANTED)[number], string> = {
      PHREN_DESKTOP_TOKEN_FD: "93", PHREN_DESKTOP_TOKEN: "daemon-token", SSH_AUTH_SOCK: "/tmp/agent.sock",
      GITHUB_TOKEN: "ghp_planted", ANTHROPIC_API_KEY: "sk-planted", VSCODE_IPC_HOOK_CLI: "/tmp/vscode.sock",
      TMUX: "/tmp/tmux-1/default,1,0", NODE_OPTIONS: "--require /tmp/x.js",
    };
    Object.assign(process.env, planted);
    const envFile = path.join(work, "env.txt");
    process.env.PHREN_REH_TARBALL = buildTarball("vscode-reh-test-any-1.0.0.tar.gz",
      `env > "${envFile}"\necho "PWD_IS=$(pwd -P)" >> "${envFile}"\necho "Extension host agent listening on 54321"\nexec sleep 30`);

    expect((await rehStatus()).available).toBe(true);

    const seen = readFileSync(envFile, "utf8");
    for (const [key, value] of Object.entries(planted)) {
      expect(seen).not.toContain(`${key}=`);
      expect(seen).not.toContain(`=${value}\n`);
    }
    expect(seen).toContain(`\nHOME=${path.join(rehRoot(), "home")}\n`);
    expect(seen).toContain(`PWD_IS=${realpathSync(path.join(rehRoot(), "home"))}\n`);
    expect(seen).toMatch(/^TMPDIR=\/tmp\/phren-reh-\d+$/m);
    expect(seen).toMatch(/^PATH=/m);
  });

  it.skipIf(process.platform !== "darwin")("keeps the host from reading the desktop key and connecting to the Hook socket", async () => {
    const bridge = path.join(work, "bridge");
    mkdirSync(bridge, { recursive: true });
    process.env.PHREN_BRIDGE_HOME = bridge;
    writeFileSync(path.join(bridge, "id_ed25519_desktop"), "PRIVATE KEY MATERIAL\n", { mode: 0o600 });
    writeFileSync(path.join(work, "readable.txt"), "workspace file\n");
    const server = createServer((socket) => socket.end("hook answered\n"));
    hook = server;
    await new Promise<void>((resolve) => server.listen(path.join(bridge, "hook.sock"), resolve));
    const probe = path.join(work, "probe.cjs");
    writeFileSync(probe, [
      `const s = require("node:net").connect(process.argv[2]);`,
      `s.on("data", (d) => { console.log("hook: " + d.toString().trim()); process.exit(0); });`,
      `s.on("error", (e) => { console.log("hook: " + e.code); process.exit(0); });`,
    ].join("\n"));
    const seen = path.join(work, "seen.txt");
    process.env.PHREN_REH_TARBALL = buildTarball("vscode-reh-test-any-1.0.0.tar.gz", [
      `cat "${bridge}/id_ed25519_desktop" > "${seen}" 2>&1 || echo "key: denied" >> "${seen}"`,
      `ls "${bridge}" >> "${seen}" 2>&1 || echo "list: denied" >> "${seen}"`,
      `cat "${work}/readable.txt" >> "${seen}"`,
      `"${process.execPath}" "${probe}" "${bridge}/hook.sock" >> "${seen}" 2>&1`,
      `echo "Extension host agent listening on 54321"`,
      "exec sleep 30",
    ].join("\n"));

    const status = await rehStatus();

    expect(status).toMatchObject({ available: true, isolation: "sandbox" });
    const log = readFileSync(seen, "utf8");
    expect(log).not.toContain("PRIVATE KEY MATERIAL");
    expect(log).toContain("key: denied");
    expect(log).toContain("list: denied");
    expect(log).not.toContain("hook answered");
    expect(log).toMatch(/hook: E(PERM|ACCES)/);
    // The same host still reads the owner's other files.
    expect(log).toContain("workspace file");
  });
});

describe("node extensions opt-in", () => {
  it("does not start the extension host until the owner turns Node extensions on", async () => {
    await setNodeExtensionsEnabled(false);
    expect(nodeExtensionsEnabled()).toBe(false);
    const status = await rehStatus();
    expect(status.available).toBe(false);
    expect(String((status as { reason?: string }).reason)).toContain("Node extensions are off");
    await setNodeExtensionsEnabled(true);
    expect(nodeExtensionsEnabled()).toBe(true);
  });
});

