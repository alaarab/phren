import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { enrollDevice, runEnrollDevice } from "./device-enroll.js";
import { enrollScript, forcedCommand } from "./install.js";
import { dispatch } from "./transport.js";

let root: string, publicKey: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-enroll-"));
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "phone", "-f", path.join(root, "phone")]);
  publicKey = (await readFile(path.join(root, "phone.pub"), "utf8")).trim();
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

const ssh = () => path.join(root, ".ssh");
const keys = () => readFile(path.join(ssh(), "authorized_keys"), "utf8");
const enroll = (input: string, device: "ios" | "android" = "ios") =>
  enrollDevice(input, { device, version: "1.2.3", sshDirectory: ssh(), root });

it("adds the phone's restricted line once and reports the computer", async () => {
  await writeFile(path.join(root, "computer-id"), "4b0c7f0e-8a43-4a52-9c1e-2b1f3e0a9d11\n");
  const first = await enroll(publicKey + "\n");
  expect(first).toMatchObject({ v: 1, ok: true, added: true, hook: "1.2.3", computer: { id: "4b0c7f0e-8a43-4a52-9c1e-2b1f3e0a9d11" } });
  const line = `restrict,pty,${forcedCommand} ${publicKey.split(" ").slice(0, 2).join(" ")} phren-iphone`;
  expect(await keys()).toBe(line + "\n");
  // Running it again, as a retry after a dropped connection would, changes nothing.
  expect(await enroll(publicKey)).toMatchObject({ ok: true, added: false });
  expect(await keys()).toBe(line + "\n");
});

it("labels an Android key and keeps other keys", async () => {
  await rm(ssh(), { recursive: true, force: true });
  execFileSync("mkdir", ["-m", "700", ssh()]);
  await writeFile(path.join(ssh(), "authorized_keys"), "ssh-ed25519 AAAAexisting someone", { mode: 0o600 });
  expect(await enroll(publicKey, "android")).toMatchObject({ ok: true, added: true, computer: { id: null } });
  const text = await keys();
  expect(text.startsWith("ssh-ed25519 AAAAexisting someone\n")).toBe(true);
  expect(text.trimEnd().endsWith(" phren-android")).toBe(true);
});

it("refuses junk, option prefixes, and the same key with other options", async () => {
  expect(await enroll("not a key")).toMatchObject({ ok: false, code: "bad-key" });
  expect(await enroll(`command="sh" ${publicKey}`)).toMatchObject({ ok: false, code: "bad-key" });
  execFileSync("mkdir", ["-m", "700", ssh()]);
  await writeFile(path.join(ssh(), "authorized_keys"), `${publicKey.split(" ").slice(0, 2).join(" ")} phren-iphone\n`, { mode: 0o600 });
  expect(await enroll(publicKey)).toMatchObject({ ok: false, code: "key-conflict" });
});

it("prints one JSON line and exits non-zero on failure", async () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value: string) => { lines.push(value); });
  const stdin = async function* (value: string) { yield Buffer.from(value); };
  expect(await runEnrollDevice(["--device", "ios", "--name", "Ala's iPhone"], "1.2.3", stdin(publicKey), { sshDirectory: ssh(), root })).toBe(0);
  expect(JSON.parse(lines[0])).toMatchObject({ ok: true, added: true });
  expect(await runEnrollDevice(["--bogus"], "1.2.3", stdin(publicKey))).toBe(1);
  expect(JSON.parse(lines[1])).toMatchObject({ ok: false, code: "usage" });
  expect(await runEnrollDevice([], "1.2.3", stdin("x".repeat(5000)))).toBe(1);
  expect(JSON.parse(lines[2])).toMatchObject({ ok: false, code: "bad-key" });
});

it("is never reachable through the phone key's forced command", async () => {
  await expect(dispatch("enroll-device")).rejects.toThrow(/only permits Phren Hook/);
  await expect(dispatch(`sh ~/.local/share/phren/bridge/enroll --device ios`)).rejects.toThrow(/only permits Phren Hook/);
});

it.skipIf(process.platform === "win32")("writes an enroll script that runs the bundle's enroll-device with its arguments", async () => {
  const script = enrollScript({ root: "/r o'ot", herdr: "/h", store: "/s", profile: "p", node: path.join(root, "node"), bundle: "/b/bridge-hook.mjs" });
  expect(script).toContain(`export PHREN_BRIDGE_HOME='/r o'\\''ot'`);
  expect(script).toContain("enroll-device \"$@\"");
  expect(script).not.toContain("SSH_ORIGINAL_COMMAND");
  await writeFile(path.join(root, "node"), `#!/bin/sh\nprintf '%s\\n' "$@"\n`, { mode: 0o700 });
  const file = path.join(root, "enroll");
  await writeFile(file, script, { mode: 0o700 });
  const child = spawn("/bin/sh", [file, "--device", "ios"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; });
  await once(child, "exit");
  expect(output.trim().split("\n")).toEqual(["/b/bridge-hook.mjs", "enroll-device", "--device", "ios"]);
});
