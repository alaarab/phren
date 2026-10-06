import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

/** Every name this computer answers to: machines.yaml often registers the
 * same Mac as its hostname, the hostname's first label and its Bonjour name.
 * The Hook reports them in /v1/health so a peer can recognize this computer. */
export function localNames(): string[] {
  const host = hostname();
  const names = [host, host.split(".")[0]];
  if (process.platform === "darwin") {
    try { names.push(execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8", timeout: 1_000 }).trim()); }
    catch { /* No Bonjour name set: the hostname forms above still match. */ }
    // The name people see in Sharing ("Sam’s Mac mini"), which the phone and schedules use.
    try { names.push(execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 1_000 }).trim()); }
    catch { /* No Sharing name set. */ }
  }
  return [...new Set(names.filter(Boolean))];
}

/** The name a schedule should carry for this computer: the Sharing name on a
 * Mac (the hostname there follows the network, "Mac" or "Mac.example.net"),
 * otherwise the hostname. */
export function stableComputerName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 1_000 }).trim();
      if (name) return name;
    } catch { /* No Sharing name set: fall back to the hostname. */ }
  }
  return hostname();
}
