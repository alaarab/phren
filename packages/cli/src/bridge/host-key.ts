import { execFile } from "node:child_process";
import { BridgeError } from "./protocol.js";

/**
 * Finding a computer's sshd ed25519 host key. sshd keeps it in /etc/ssh on
 * most systems, but Asustor ADM uses /usr/etc/ssh and Homebrew or Entware
 * builds use their own prefix, so ask sshd first and search the usual
 * directories after.
 */

export const HOST_KEY_DIRS = ["/etc/ssh", "/usr/etc/ssh", "/usr/local/etc/ssh", "/opt/etc/ssh"];

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** A POSIX sh script that prints the first ssh-ed25519 host public key line,
 * from sshd -T's hostkey entries then `dirs`; it prints nothing when there is none. */
export function hostKeyScript(dirs: string[] = HOST_KEY_DIRS, sshd = "sshd"): string {
  const candidates = dirs.map(dir => quote(`${dir}/ssh_host_ed25519_key`)).join(" ");
  return `keys=$( (PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin:/opt/sbin" ${quote(sshd)} -T 2>/dev/null) | awk '$1 == "hostkey" { print $2 }')
for k in $keys ${candidates}; do
  [ -r "$k.pub" ] || continue
  line=$(head -n 1 "$k.pub")
  case "$line" in "ssh-ed25519 "*) printf '%s\\n' "$line"; exit 0;; esac
done
true`;
}

export function noHostKey(where: string, dirs: string[] = HOST_KEY_DIRS): BridgeError {
  return new BridgeError(409, `${where} has no ssh-ed25519 host key: none in sshd -T's hostkey entries or ${dirs.join(", ")}. Generate one with sudo ssh-keygen -A and restart sshd.`);
}

/** The first ed25519 host public key line out of hostKeyScript's output. */
export function hostKeyLine(stdout: string): string | undefined {
  return stdout.split("\n").map(line => line.trim()).find(line => line.startsWith("ssh-ed25519 "));
}

/** This computer's ed25519 host public key line, or undefined when it has none. */
export function localHostKeyLine(dirs?: string[], sshd?: string): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile("sh", ["-c", hostKeyScript(dirs, sshd)], { timeout: 10_000 }, (error, stdout) => resolve(hostKeyLine(stdout ?? "")));
  });
}
