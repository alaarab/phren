import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hookRequest } from "./client.js";
import type { ComputerSet } from "./conductor-group.js";

const exec = promisify(execFile);
const bundle = path.resolve(process.env.PHREN_TEST_HOOK_BUNDLE || "packages/cli/dist/bridge-hook.mjs");
const cli = path.resolve("packages/cli/dist/index.js");
const machines = [
  { name: "Devbox", hostname: "workstation", id: "adb03b73-cc59-4e41-b4a2-3eb73b90ef2c" },
  { name: "Mini", hostname: "Sams-Mac-mini.local", id: "5e1c9a52-6d0e-4b8a-9e27-c4d1a7b05e63" },
  { name: "MacBook", hostname: "MacBookPro", id: "42ceb0c6-283c-44a9-991f-08ceb110125e" },
];

// Three real bundled Hook processes, each with its own id and hostname.
// The SSH executable forwards the byte pipe to the peer's real Unix socket,
// as bridge.suite.ts does; no Hook route or identity response is mocked.
describe.skipIf(process.platform === "win32")("sets across three real Hooks", () => {
  let root: string;
  const hooks: ChildProcess[] = [];
  const logs: string[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const socket = (name: string) => path.join(root, name, "bridge/hook.sock");

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-sets-"));
    await mkdir(path.join(root, "bin"));
    const preload = path.join(root, "hostname.cjs");
    await writeFile(preload, `require("node:os").hostname = () => process.env.PHREN_TEST_HOSTNAME;
require("node:module").syncBuiltinESMExports();\n`);
    let hostKey: string;
    try { hostKey = (await readFile("/etc/ssh/ssh_host_ed25519_key.pub", "utf8")).trim().split(/\s+/).slice(0, 2).join(" "); }
    catch { hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEp8VWGvSO7U7OMdQo3CQgkVv41Gw2cztUk5uiefMuhg"; }
    const routes = Object.fromEntries(machines.map(machine => [machine.hostname.split(".")[0].toLowerCase() + ".example", socket(machine.name)]));
    await writeFile(path.join(root, "bin/ssh"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.at(-1) !== "phren-hook v1 pipe" || !args.includes("StrictHostKeyChecking=yes")) process.exit(2);
const routes = ${JSON.stringify(routes)};
const socket = require("node:net").connect(routes[args[args.indexOf("--") + 1]]);
socket.on("connect", () => { process.stdin.pipe(socket); socket.pipe(process.stdout); });
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(0));\n`, { mode: 0o700 });
    for (const machine of machines) {
      const home = path.join(root, machine.name), bridge = path.join(home, "bridge");
      await mkdir(bridge, { recursive: true });
      await mkdir(path.join(home, "store/.config"), { recursive: true });
      await writeFile(path.join(home, "store/phren.root.yaml"), "version: 1\n");
      await writeFile(path.join(home, "store/.config/modules.yaml"), "version: 1\nenabled:\n  memory: true\n  hook: true\n  conductor: true\n");
      await writeFile(path.join(bridge, "computer-id"), machine.id, { mode: 0o600 });
      await writeFile(path.join(bridge, "id_ed25519_dispatch"), "fixture key", { mode: 0o600 });
      await writeFile(path.join(bridge, "hooks.yaml"), JSON.stringify({ version: 1, computers: machines.filter(peer => peer !== machine).map(peer => ({
        name: peer.name, address: peer.hostname.split(".")[0].toLowerCase() + ".example", username: "sam", hostKey,
      })) }), { mode: 0o600 });
      const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
        PHREN_PATH: path.join(home, "store"), PHREN_BRIDGE_HOME: bridge, PHREN_HERDR_HOME: path.join(home, "herdr"),
        CODEX_HOME: path.join(home, "codex"), CLAUDE_CONFIG_DIR: path.join(home, "claude"),
        PHREN_TEST_HOSTNAME: machine.hostname, PHREN_TMUX: "off", PATH: `${path.join(root, "bin")}:${process.env.PATH}` };
      envs.push(env);
      const index = hooks.length;
      logs[index] = "";
      const hook = spawn(process.execPath, ["--require", preload, bundle, "serve"], { env, stdio: ["ignore", "ignore", "pipe"] });
      hook.stderr!.on("data", bytes => logs[index] += bytes.toString());
      hooks.push(hook);
    }
    for (const machine of machines) {
      const deadline = Date.now() + 5_000;
      let ready = false;
      while (!ready && Date.now() < deadline) {
        ready = await hookRequest("/v1/health", undefined, { socketPath: socket(machine.name) }, 500).then(() => true, () => false);
        if (!ready) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(ready, logs.join("\n")).toBe(true);
    }
  }, 15_000);

  afterAll(async () => {
    await Promise.all(hooks.map(async hook => {
      if (hook.exitCode !== null || hook.signalCode !== null) return;
      const exited = once(hook, "exit");
      hook.kill("SIGTERM");
      const timer = setTimeout(() => hook.kill("SIGKILL"), 3_000);
      await exited;
      clearTimeout(timer);
    }));
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(machines)("$name returns one self row and prints its friendly name without a self-link hint", async machine => {
    // Cold caches: /v1/sets must establish identity without a prior /v1/computers poll.
    const result = await hookRequest("/v1/sets", undefined, { socketPath: socket(machine.name) }, 25_000);
    const sets = result.sets as unknown as ComputerSet[];
    expect(sets).toHaveLength(1);
    expect(sets[0].id).toBe("set:42ceb0c6-283c-44a9-991f-08ceb110125e");
    expect(sets[0].local).toBe(true);
    expect(sets[0].computers).toHaveLength(3);
    expect(sets[0].computers.map(row => row.id).sort()).toEqual(machines.map(row => row.id).sort());
    expect(sets[0].computers.filter(row => row.local)).toEqual([
      { name: machine.name, id: machine.id, local: true, reachable: true, link: "self" },
    ]);
    expect(sets[0].computers.filter(row => !row.local).every(row => row.link === "two-way" && row.reachable)).toBe(true);
    expect(sets[0].computers.some(row => row.hint)).toBe(false);
    if (machine.name === "Devbox") {
      const fixture = JSON.parse(await readFile(new URL("../../fixtures/conformance/sets-local-friendly-name.json", import.meta.url), "utf8"));
      expect(result).toEqual(fixture);
    }
    const env = envs[machines.indexOf(machine)];
    const output = await exec(process.execPath, [cli, "conductor", "sets"], { env, timeout: 25_000 });
    expect(output.stdout).toContain(`  ${machine.name}: this computer\n`);
    expect(output.stdout).not.toContain("Link it with");
    expect(output.stdout.split("\n").filter(line => /^  /.test(line))).toHaveLength(3);
    const json = await exec(process.execPath, [cli, "conductor", "sets", "--json"], { env, timeout: 25_000 });
    expect(JSON.parse(json.stdout)).toEqual(result);
  }, 30_000);
});
