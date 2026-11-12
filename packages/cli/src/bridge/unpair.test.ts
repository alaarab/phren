import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayConnections, parseProcessRows, phoneKeys, runUnpair } from "./unpair.js";

const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g";
const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9A";
const PHONE = 'restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch"';
const FILE = [
  "# my own key",
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh me@laptop",
  `${PHONE} ${KEY_A} phren-iphone`,
  `restrict,command="sh ~/.local/share/phren/bridge/dispatch-scoped peer:mini" ${KEY_B} phren-computer:mini`,
  `${PHONE} ${KEY_B} phren-android`,
  "",
].join("\n");

describe("phren unpair", () => {
  let directory: string, log: string[], errors: string[];
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "phren-unpair-"));
    await writeFile(path.join(directory, "authorized_keys"), FILE, { mode: 0o600 });
    log = []; errors = [];
    vi.spyOn(console, "log").mockImplementation((...parts) => { log.push(parts.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...parts) => { errors.push(parts.join(" ")); });
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
  const file = () => readFile(path.join(directory, "authorized_keys"), "utf8");

  it("lists only phone keys, with the fingerprint ssh-keygen shows", async () => {
    const keys = phoneKeys(FILE);
    expect(keys.map(key => key.device)).toEqual(["ios", "android"]);
    // ssh-keygen -lf on KEY_A prints this fingerprint.
    expect(keys[0].fingerprint).toBe("SHA256:mKqU+0K8OhKmA8bBQi9Rz0Q5l7/g160hIP+rJYSTNj4");
    expect(await runUnpair([], { sshDirectory: directory, endConnections: async () => { throw new Error("listing must not end connections"); } })).toBe(0);
    expect(log.join("\n")).toContain("1. iPhone  SHA256:");
    expect(await file()).toBe(FILE);
  });

  it("removes the chosen phone, leaves every other line as it was, and ends open connections", async () => {
    let ended = 0;
    expect(await runUnpair(["1"], { sshDirectory: directory, endConnections: async () => { ended++; return 2; } })).toBe(0);
    expect(await file()).toBe(FILE.replace(`${PHONE} ${KEY_A} phren-iphone\n`, ""));
    expect(ended).toBe(1);
    expect(log.join("\n")).toContain("Ended 2 open Phren connections");
  });

  it("removes by fingerprint and with --all, and never touches a computer or personal key", async () => {
    const android = phoneKeys(FILE)[1].fingerprint;
    expect(await runUnpair([android], { sshDirectory: directory, endConnections: async () => 0 })).toBe(0);
    expect(phoneKeys(await file()).map(key => key.device)).toEqual(["ios"]);
    expect(await runUnpair(["--all"], { sshDirectory: directory, endConnections: async () => 0 })).toBe(0);
    const left = await file();
    expect(phoneKeys(left)).toEqual([]);
    expect(left).toContain("me@laptop");
    expect(left).toContain("phren-computer:mini");
  });

  it("changes nothing and ends nothing when no phone matches", async () => {
    const never = async () => { throw new Error("must not end connections"); };
    expect(await runUnpair(["7"], { sshDirectory: directory, endConnections: never })).toBe(1);
    expect(await runUnpair(["SHA256:nope"], { sshDirectory: directory, endConnections: never })).toBe(1);
    expect(await file()).toBe(FILE);
    expect(errors.join("\n")).toContain("No paired phone matches");
  });

  it("reports failure when the key is gone but open connections could not be ended", async () => {
    expect(await runUnpair(["1"], { sshDirectory: directory, endConnections: async () => { throw new Error("ps failed"); } })).toBe(1);
    expect(phoneKeys(await file()).length).toBe(1);
    expect(errors.join("\n")).toContain("may keep working");
  });
});

describe("the SSH connections unpair ends", () => {
  const root = "/Users/me/.local/share/phren/bridge";
  const rows = parseProcessRows([
    "    1     0     0 /sbin/launchd",
    "  100     1     0 sshd-session: me [priv]",
    "  101   100   501 sshd-session: me@notty",
    `  102   101   501 nc -U ${root}/hook.sock`,
    "  200     1     0 sshd: me [priv]",
    "  201   200   501 sshd: me@pts/3",
    "  202   201   501 -zsh",
    "  203   202   501 node /usr/local/bin/phren unpair 1",
    "  300     1     0 sshd-session: me [priv]",
    "  301   300   501 sshd-session: me@notty",
    "  400     1     0 sshd-session: me [priv]",
    "  401   400   501 sshd-session: me@ttys004",
    `  402   401   501 /opt/node/bin/node ${root}/current/bridge-hook.mjs ssh`,
    "  403   402   501 -zsh -l",
    "  500     1     0 sshd-session: other [priv]",
    "  501   500   502 sshd-session: other@notty",
    "  600     1     0 sshd-session: me [priv]",
    "  601   600   501 sshd-session: me@notty",
    `  602   601   501 nc -U ${root}/hook.sock`,
    "  603   601   501 /usr/libexec/sftp-server",
    "  700     1     0 sshd-session: me [priv]",
    "  701   700   501 sshd-session: me",
    "  800     1     0 sshd: me [priv]",
    "  801   800   501 sshd: me@notty",
    "  802   801   501 sshd: me@internal-sftp",
  ].join("\n"));

  it("ends connections running only the Phren gateway or nothing, and no one else's", () => {
    const { sessions, children } = gatewayConnections(rows, { uid: 501, root, self: 203 });
    // 701 signed in and has not opened a channel yet; 801/802 is an SFTP transfer.
    expect(sessions).toEqual([101, 301, 401, 701]);
    expect(children).toEqual([102, 402]);
  });

  it("never ends the connection the command itself runs in", () => {
    const own = parseProcessRows(["  701   700   501 sshd-session: me@notty", `  702   701   501 node ${root}/current/bridge-hook.mjs ssh`].join("\n"));
    expect(gatewayConnections(own, { uid: 501, root, self: 702 }).sessions).toEqual([]);
  });
});
