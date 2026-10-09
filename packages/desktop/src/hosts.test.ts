import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadComputers, sshArgs } from "./hosts.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOk6rp5mZR9NnYyyPgxvdi6cGYXJqjcnO5YtupyDMgcQ";
let root: string;
const previous = process.env.PHREN_BRIDGE_HOME;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "desktop-hosts-")); process.env.PHREN_BRIDGE_HOME = root; });
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

describe("sshArgs", () => {
  it("pins the host key, uses the computer's key and passes the command as one argument", async () => {
    await writeFile(path.join(root, "desktop.yaml"), peers("Desk"));
    const [, desk] = await loadComputers();
    const args = sshArgs(desk, "phren-hook v1 pipe");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ClearAllForwardings=yes");
    expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", path.join(root, "id_ed25519_desktop")]);
    expect(args.slice(-2)).toEqual(["me@box", "phren-hook v1 pipe"]);
    expect(args).not.toContain("-tt");
    expect(sshArgs(desk, "x", { tty: true })).toContain("-tt");
  });

  it("refuses the local computer", () => {
    expect(() => sshArgs({ name: "This computer", local: true, server: "default" }, "x")).toThrow(/local/);
  });
});
