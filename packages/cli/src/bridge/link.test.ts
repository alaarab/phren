import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sshConfigHosts } from "./link.js";
import { addHookPeer, hookPeers } from "./peers.js";

it("probes only concrete ssh hosts, never patterns or Git hosting services", () => {
  const config = [
    "Host github.com github-work", "  HostName github.com", "  IdentityFile ~/.ssh/work",
    "Host macbook sams-macbook-pro", "  HostName sams-macbook-pro # tailscale", "  User octo",
    "# Host commented-out",
    "Host *.internal !bastion build-?", "  User deploy",
    "Host=workstation", "Match host staging", "  User ops",
    "Host gitlab.com",
  ].join("\n");
  expect(sshConfigHosts(config)).toEqual(["macbook", "sams-macbook-pro", "workstation"]);
});

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-link-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEp8VWGvSO7U7OMdQo3CQgkVv41Gw2cztUk5uiefMuhg";

// hooks.yaml must be mode 0600, and Windows files carry no POSIX mode bits;
// the Hook supports macOS and Linux only.
it.skipIf(process.platform === "win32")("pins a linked computer in a private hooks.yaml once, and refuses a different computer under its name or address", async () => {
  const mini = { name: "Mini", address: "sams-mac-mini", username: "sam", port: 22, server: "default", hostKey: `${key} root@mini` };
  expect(await addHookPeer(mini, root)).toMatchObject({ added: true });
  // Linking again is a no-op, so an interrupted link can simply be rerun.
  expect(await addHookPeer(mini, root)).toMatchObject({ added: false });
  expect((await stat(path.join(root, "hooks.yaml"))).mode & 0o777).toBe(0o600);
  expect(await hookPeers(root)).toEqual([{ ...mini, hostKey: key }]);

  await expect(addHookPeer({ ...mini, username: "someone" }, root)).rejects.toThrow("hooks.yaml already has Mini at sams-mac-mini");
  await expect(addHookPeer({ ...mini, name: "Desk" }, root)).rejects.toThrow("hooks.yaml already has Mini");
  await addHookPeer({ ...mini, name: "Devbox", address: "workstation", username: "octo" }, root);
  expect((await hookPeers(root)).map(peer => peer.name)).toEqual(["Mini", "Devbox"]);
  expect(await readFile(path.join(root, "hooks.yaml"), "utf8")).toMatch(/^version: 1\ncomputers:\n/);
});

it.skipIf(process.platform === "win32")("keeps every peer when links run at once or wait on another process's hooks.yaml lock", async () => {
  const peer = (n: number) => ({ name: `Box${n}`, address: `box-${n}`, username: "sam", port: 22, server: "default", hostKey: key });
  await Promise.all([1, 2, 3, 4].map(n => addHookPeer(peer(n), root)));
  expect((await hookPeers(root)).map(p => p.name).sort()).toEqual(["Box1", "Box2", "Box3", "Box4"]);

  // A live process (our parent) holds the lock: the link waits for it, then reads afresh.
  const lock = path.join(root, "hooks.yaml.lock");
  await writeFile(lock, `${process.ppid}\n${Date.now()}\n0`);
  const pending = addHookPeer(peer(5), root);
  await new Promise(resolve => setTimeout(resolve, 150));
  expect((await hookPeers(root)).map(p => p.name)).not.toContain("Box5");
  await rm(lock);
  await pending;
  expect((await hookPeers(root)).map(p => p.name)).toHaveLength(5);
});
