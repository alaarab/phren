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
  }
  return [...new Set(names.filter(Boolean))];
}
