import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { appendAuthorizedKey, publicComputerKey } from "./computers.js";
import { forcedCommand } from "./install.js";
import { computerDisplayName } from "./pair.js";
import { BridgeError, bridgeRoot } from "./protocol.js";

export const ENROLL_DEVICE_USAGE = "enroll-device [--device ios|android] [--name <device name>] < public-key";

export type EnrollDeviceReply =
  | { v: 1; ok: true; added: boolean; user: string; computer: { id: string | null; name: string }; hook: string }
  | { v: 1; ok: false; code: "bad-key" | "key-conflict" | "enroll-busy" | "ssh-directory" | "usage" | "internal"; error: string };

/**
 * Adds one phone's restricted key, the same line `phren pair` writes. The
 * phone runs this once over an SSH session it signed into with the user's
 * password, then connects with the key. An identical line already present is
 * success (`added: false`); the same key with other options is a conflict.
 */
export async function enrollDevice(input: string, options: {
  device: "ios" | "android"; version: string; sshDirectory?: string; root?: string;
}): Promise<EnrollDeviceReply> {
  try {
    const publicKey = publicComputerKey(input);
    const comment = options.device === "android" ? "phren-android" : "phren-iphone";
    const line = `restrict,pty,${forcedCommand} ${publicKey} ${comment}`;
    const encoded = publicKey.split(" ")[1];
    const file = path.join(options.sshDirectory ?? path.join(homedir(), ".ssh"), "authorized_keys");
    const before = await readFile(file, "utf8").catch(() => "");
    await appendAuthorizedKey(line, existing => existing.split(/\s+/).includes(encoded),
      "This phone key is already authorized with different options.", options.sshDirectory);
    const id = await readFile(path.join(options.root ?? bridgeRoot(), "computer-id"), "utf8").then(value => value.trim() || null).catch(() => null);
    return { v: 1, ok: true, added: !before.split("\n").includes(line), user: userInfo().username,
      computer: { id, name: await computerDisplayName() }, hook: options.version };
  } catch (error) {
    const message = (error as Error).message;
    const code = !(error instanceof BridgeError) ? "internal"
      : error.status === 400 ? "bad-key"
        : /already running/.test(message) ? "enroll-busy"
          : /SSH directory/.test(message) ? "ssh-directory" : "key-conflict";
    return { v: 1, ok: false, code, error: message };
  }
}

/** `bridge-hook.mjs enroll-device`: the key on stdin, one JSON line out. */
export async function runEnrollDevice(args: string[], version: string,
  stdin: AsyncIterable<Buffer | string> = process.stdin, options: { sshDirectory?: string; root?: string } = {}): Promise<number> {
  const reply = (value: EnrollDeviceReply) => { console.log(JSON.stringify(value)); return value.ok ? 0 : 1; };
  let device: "ios" | "android" = "ios";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--device" && (args[i + 1] === "ios" || args[i + 1] === "android")) device = args[++i] as "ios" | "android";
    // The phone's name only labels this run; the key's comment is fixed.
    else if (args[i] === "--name" && args[i + 1] !== undefined) i++;
    else return reply({ v: 1, ok: false, code: "usage", error: `Usage: ${ENROLL_DEVICE_USAGE}` });
  }
  let input = "";
  for await (const chunk of stdin) {
    input += chunk.toString();
    if (input.length > 4096) return reply({ v: 1, ok: false, code: "bad-key", error: "Supply one ed25519 public key." });
  }
  return reply(await enrollDevice(input, { device, version, ...options }));
}
