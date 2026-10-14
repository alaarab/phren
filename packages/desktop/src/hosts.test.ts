import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { knownHostsPath, loadComputers, masterExitArgs, masterKey, sshArgs } from "./hosts.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEp8VWGvSO7U7OMdQo3CQgkVv41Gw2cztUk5uiefMuhg";
let root: string;
const previous = process.env.PHREN_BRIDGE_HOME;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "desktop-hosts-"));
  process.env.PHREN_BRIDGE_HOME = root;
  await writeFile(path.join(root, "id_ed25519_desktop"), "private desktop");
  await writeFile(path.join(root, "id_ed25519_dispatch"), "private dispatch");
  await writeFile(path.join(root, "other"), "private other");
});
afterEach(async () => { process.env.PHREN_BRIDGE_HOME = previous; await rm(root, { recursive: true, force: true }); });

const peers = (name: string) => `version: 1\ncomputers:\n  - name: ${name}\n    address: box\n    username: me\n    port: 2222\n    hostKey: ${KEY}\n`;

describe("loadComputers", () => {
  it("is only this computer when nothing is linked", async () => {
    expect(await loadComputers()).toEqual([{ name: "This computer", local: true, server: "default" }]);
  });

  it("uses desktop.yaml and the desktop key when it exists, ignoring hooks.yaml", async () => {
    await writeFile(path.join(root, "hooks.yaml"), peers("Peer"));
    await writeFile(path.join(root, "desktop.yaml"), peers("Desk"));
    const [, desk, ...more] = await loadComputers();
    expect(more).toEqual([]);
    expect(desk).toMatchObject({ name: "Desk", address: "box", port: 2222, server: "default", keyFile: path.join(root, "id_ed25519_desktop") });
  });

  it("falls back to hooks.yaml with the dispatch key", async () => {
    await writeFile(path.join(root, "hooks.yaml"), peers("Peer"));
    const [, peer] = await loadComputers();
    expect(peer).toMatchObject({ name: "Peer", keyFile: path.join(root, "id_ed25519_dispatch") });
  });

  it("names the file and field that is wrong", async () => {
    await writeFile(path.join(root, "desktop.yaml"), "version: 1\ncomputers:\n  - name: X\n");
    await expect(loadComputers()).rejects.toThrow(/desktop\.yaml is invalid at computers\[0\]\.address/);
  });
});

const CONTROL_PATH = /^ControlPath=\/tmp\/phren-desktop-\d+\/[0-9a-f]{24}-(\d)$/;

function controlPath(args: string[]): string {
  const option = args.find(arg => arg.startsWith("ControlPath="));
  if (!option) throw new Error("no ControlPath in args");
  return option;
}

// OpenSSH ControlMaster sockets and key paths: POSIX only.
describe.skipIf(process.platform === "win32")("sshArgs", () => {
  it("pins the host key, uses the computer's key and passes the command as one argument", async () => {
    await writeFile(path.join(root, "desktop.yaml"), peers("Desk"));
    const [, desk] = await loadComputers();
    const args = sshArgs(desk, "phren-hook v1 pipe");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ClearAllForwardings=yes");
    expect(args).toContain("ControlPersist=60");
    expect(args).toContain("ServerAliveInterval=15");
    expect(args).toContain("ServerAliveCountMax=3");
    expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", path.join(root, "id_ed25519_desktop")]);
    expect(args.slice(-2)).toEqual(["me@box", "phren-hook v1 pipe"]);
    expect(args).not.toContain("-tt");
    expect(sshArgs(desk, "x", { tty: true })).toContain("-tt");
  });

  it("keys the master socket by identity and slot", async () => {
    await writeFile(path.join(root, "desktop.yaml"), peers("Desk"));
    const [, desk] = await loadComputers();
    expect(controlPath(sshArgs(desk, "x"))).toMatch(CONTROL_PATH);
    expect(controlPath(sshArgs(desk, "x"))).toMatch(/-0$/);
    const slot2 = controlPath(sshArgs(desk, "x", { slot: 2 }));
    expect(slot2).toMatch(/-2$/);
    // Same key, same slot: stable path.
    expect(slot2).toBe(controlPath(sshArgs(desk, "x", { slot: 2 })));
    expect(slot2).not.toBe(controlPath(sshArgs(desk, "x")));
  });

  it("never shares a master between two identities for the same destination", async () => {
    await writeFile(path.join(root, "desktop.yaml"), peers("Desk"));
    const [, desk] = await loadComputers();
    const other = { ...desk, keyFile: path.join(root, "id_ed25519_dispatch") };
    expect(controlPath(sshArgs(other, "x"))).not.toBe(controlPath(sshArgs(desk, "x")));
    // Teardown targets the exact master each identity's channels used.
    expect(controlPath(masterExitArgs(desk, 1))).toBe(controlPath(sshArgs(desk, "x", { slot: 1 })));
    expect(controlPath(masterExitArgs(other, 1))).toBe(controlPath(sshArgs(other, "x", { slot: 1 })));
  });

  it("rewrites the pinned known_hosts after revoke deleted it", async () => {
    await writeFile(path.join(root, "desktop.yaml"), peers("Desk"));
    const [, desk] = await loadComputers();
    sshArgs(desk, "x");
    await rm(knownHostsPath("Desk"));
    sshArgs(desk, "x");
    expect(existsSync(knownHostsPath("Desk"))).toBe(true);
  });

  it("pools channels by identity and destination, not by name", async () => {
    await writeFile(path.join(root, "desktop.yaml"), peers("Desk"));
    const [, desk] = await loadComputers();
    expect(masterKey({ ...desk, name: "Alias" })).toBe(masterKey(desk));
    expect(masterKey({ ...desk, keyFile: path.join(root, "other") })).not.toBe(masterKey(desk));
    expect(masterKey({ ...desk, port: 22 })).not.toBe(masterKey(desk));
  });

  it("isolates a changed pin or private key at the same pathname", async () => {
    await writeFile(path.join(root, "desktop.yaml"), peers("Desk"));
    const [, desk] = await loadComputers();
    const originalKey = masterKey(desk);
    const originalPath = controlPath(sshArgs(desk, "x"));
    const repinned = { ...desk, hostKey: "ssh-ed25519 AAAANEWPIN" };
    expect(masterKey(repinned)).not.toBe(originalKey);
    expect(controlPath(sshArgs(repinned, "x"))).not.toBe(originalPath);
    await writeFile(desk.keyFile!, "private replacement");
    expect(masterKey(desk)).not.toBe(originalKey);
    expect(controlPath(sshArgs(desk, "x"))).not.toBe(originalPath);
    const alias = path.join(root, "alias");
    await writeFile(alias, "private replacement");
    expect(masterKey({ ...desk, keyFile: alias })).toBe(masterKey(desk));
  });

  it("refuses the local computer", () => {
    expect(() => sshArgs({ name: "This computer", local: true, server: "default" }, "x")).toThrow(/local/);
  });
});

describe.skipIf(process.platform === "win32")("masterExitArgs", () => {
  it("targets one slot's ControlMaster", async () => {
    await writeFile(path.join(root, "desktop.yaml"), peers("Desk"));
    const [, desk] = await loadComputers();
    const args = masterExitArgs(desk, 3);
    expect(args).toContain("-F");
    expect(args).toContain("/dev/null");
    expect(controlPath(args)).toMatch(/-3$/);
    expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual(["-p", "2222"]);
    expect(args).toContain("me@box");
    expect(args.slice(-2)).toEqual(["-O", "exit"]);
  });

  it("refuses the local computer", () => {
    expect(() => masterExitArgs({ name: "This computer", local: true, server: "default" }, 0)).toThrow(/local/);
  });
});
