import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptComputer, computerKeyLine, dispatchKeyPath, enrollComputer, publicComputerKey } from "./computers.js";
import { hookPeers, peerSSHArgs } from "./peers.js";

describe("computer enrollment", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-computer-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("creates one private identity and prints the phone's restricted forced command", async () => {
    const line = await enrollComputer("Desk", root);
    expect(line).toMatch(/^restrict,pty,command="sh ~\/\.local\/share\/phren\/bridge\/dispatch" ssh-ed25519 \S+ phren-computer:Desk$/);
    expect(line).not.toContain("port-forwarding");
    expect(await enrollComputer("Desk", root)).toBe(line);
    expect((await stat(dispatchKeyPath(root))).mode & 0o777).toBe(0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect(line).not.toContain("PRIVATE KEY");
  });

  it("accepts idempotently, preserves existing keys and refuses silent key replacement", async () => {
    const line = await enrollComputer("Desk", root), ssh = path.join(root, "ssh");
    await acceptComputer("Desk", line, ssh);
    const file = path.join(ssh, "authorized_keys");
    await writeFile(file, "# sam's existing keys\n" + await readFile(file, "utf8"));
    await acceptComputer("Desk", line, ssh);
    expect(await readFile(file, "utf8")).toBe("# sam's existing keys\n" + line + "\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const other = await enrollComputer("Desk", path.join(root, "other"));
    await expect(acceptComputer("Desk", other, ssh)).rejects.toThrow("already enrolled differently");
    await expect(acceptComputer("Linuxbox", line, ssh)).rejects.toThrow("already enrolled differently");
    await expect(acceptComputer("Desk", line.replace("restrict,pty", "restrict,port-forwarding"), ssh)).rejects.toThrow("public key");
  });

  it("rejects malformed keys, names and symlink destinations", async () => {
    for (const name of ["../Desk", "anywhere", "Desk\nLinuxbox"]) await expect(enrollComputer(name, root)).rejects.toThrow();
    expect(() => publicComputerKey("ssh-ed25519 AAAA")).toThrow("Invalid");
    const line = await enrollComputer("Desk", root);
    const file = path.join(root, "keep"); await writeFile(file, "unchanged");
    await acceptComputer("Desk", line, path.join(root, "ssh"));
    await rm(path.join(root, "ssh/authorized_keys"));
    await symlink(file, path.join(root, "ssh/authorized_keys"));
    await expect(acceptComputer("Desk", line, path.join(root, "ssh"))).rejects.toThrow("unexpected");
    expect(await readFile(file, "utf8")).toBe("unchanged");
  });

  it("requires a private peer file and pins SSH independently of user configuration", async () => {
    const line = await enrollComputer("Desk", root);
    const key = line.slice(line.indexOf("ssh-ed25519"));
    const hostKey = publicComputerKey(key);
    expect(computerKeyLine("Linuxbox", key)).toContain("phren-computer:Linuxbox");
    const file = path.join(root, "hooks.yaml");
    await writeFile(file, JSON.stringify({ version: 1, computers: [{ name: "Desk", address: "desk.example", username: "sam", hostKey }] }), { mode: 0o600 });
    const [peer] = await hookPeers(root);
    const args = peerSSHArgs(peer, "known_hosts", "id_ed25519_dispatch");
    expect(args).toEqual(expect.arrayContaining(["/dev/null", "StrictHostKeyChecking=yes", "IdentityAgent=none", "GlobalKnownHostsFile=/dev/null", "ClearAllForwardings=yes", "HostKeyAlias=phren-peer"]));
    expect(args.slice(-3)).toEqual(["--", "desk.example", "phren-hook v1 pipe"]);
    await writeFile(file, JSON.stringify({ version: 1, computers: [peer, peer] }));
    await expect(hookPeers(root)).rejects.toThrow("duplicate");
    await chmod(file, 0o644);
    await expect(hookPeers(root)).rejects.toThrow("0600");
  });
});
