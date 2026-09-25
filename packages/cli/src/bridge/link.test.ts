import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sshConfigHosts } from "./link.js";
import { addHookPeer, hookPeers } from "./peers.js";

it("probes only concrete ssh hosts, never patterns or Git hosting services", () => {
  const config = [
    "Host github.com github-work", "  HostName github.com", "  IdentityFile ~/.ssh/work",
    "Host macbook alas-macbook-pro", "  HostName alas-macbook-pro # tailscale", "  User alaarab",
    "# Host commented-out",
    "Host *.internal !bastion build-?", "  User deploy",
    "Host=omarchy", "Match host staging", "  User ops",
    "Host gitlab.com",
  ].join("\n");
  expect(sshConfigHosts(config)).toEqual(["macbook", "alas-macbook-pro", "omarchy"]);
});

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-link-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPKDk8cewh74xDIccwQz/N4V05hPT+bdp5fEii+pzf9B";

it("pins a linked computer in a private hooks.yaml once, and refuses a different computer under its name or address", async () => {
  const mini = { name: "Mini", address: "squids-mac-mini", username: "squidbot", port: 22, server: "default", hostKey: `${key} root@mini` };
  expect(await addHookPeer(mini, root)).toMatchObject({ added: true });
  // Linking again is a no-op, so an interrupted link can simply be rerun.
  expect(await addHookPeer(mini, root)).toMatchObject({ added: false });
  expect((await stat(path.join(root, "hooks.yaml"))).mode & 0o777).toBe(0o600);
  expect(await hookPeers(root)).toEqual([{ ...mini, hostKey: key }]);

  await expect(addHookPeer({ ...mini, username: "someone" }, root)).rejects.toThrow("hooks.yaml already has Mini at squids-mac-mini");
  await expect(addHookPeer({ ...mini, name: "Desk" }, root)).rejects.toThrow("hooks.yaml already has Mini");
  await addHookPeer({ ...mini, name: "Linuxbox", address: "omarchy", username: "alaarab" }, root);
  expect((await hookPeers(root)).map(peer => peer.name)).toEqual(["Mini", "Linuxbox"]);
  expect(await readFile(path.join(root, "hooks.yaml"), "utf8")).toMatch(/^version: 1\ncomputers:\n/);
});
