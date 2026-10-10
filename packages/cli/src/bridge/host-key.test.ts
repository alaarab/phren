import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { localHostKeyLine } from "./host-key.js";

const ed25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEp8VWGvSO7U7OMdQo3CQgkVv41Gw2cztUk5uiefMuhg root@nas";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-hostkey-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const dirs = () => ["/etc/ssh", "/usr/etc/ssh", "/usr/local/etc/ssh", "/opt/etc/ssh"].map(dir => path.join(root, dir));
const put = async (file: string, text: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${text}\n`); };

// The Hook supports macOS and Linux only; the search is a POSIX sh script.
it.skipIf(process.platform === "win32")("finds an Asustor-style /usr/etc/ssh host key when /etc/ssh has only an RSA key", async () => {
  await put(path.join(root, "etc/ssh/ssh_host_rsa_key.pub"), "ssh-rsa AAAAB3NzaC1yc2E root@nas");
  await put(path.join(root, "usr/etc/ssh/ssh_host_ed25519_key.pub"), ed25519);
  expect(await localHostKeyLine(dirs(), path.join(root, "no-sshd"))).toBe(ed25519);
});

it.skipIf(process.platform === "win32")("prefers the ed25519 hostkey sshd -T reports over the usual directories", async () => {
  const custom = path.join(root, "custom/keys/host_ed25519");
  const other = ed25519.replace("root@nas", "root@custom");
  await put(`${custom}.pub`, other);
  await put(path.join(root, "etc/ssh/ssh_host_ed25519_key.pub"), ed25519);
  const sshd = path.join(root, "sshd");
  await writeFile(sshd, `#!/bin/sh\nprintf 'port 22\\nhostkey ${root}/custom/keys/host_rsa\\nhostkey ${custom}\\n'\n`);
  await chmod(sshd, 0o755);
  expect(await localHostKeyLine(dirs(), sshd)).toBe(other);
});

it.skipIf(process.platform === "win32")("finds nothing when no ed25519 host key exists", async () => {
  await put(path.join(root, "usr/etc/ssh/ssh_host_ecdsa_key.pub"), "ecdsa-sha2-nistp256 AAAAE2Vj root@nas");
  expect(await localHostKeyLine(dirs(), path.join(root, "no-sshd"))).toBeUndefined();
});
