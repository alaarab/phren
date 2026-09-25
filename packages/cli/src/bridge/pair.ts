import { execFile } from "node:child_process";
import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { homedir, hostname, networkInterfaces, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { appendAuthorizedKey, publicComputerKey } from "./computers.js";
import { forcedCommand, install } from "./install.js";
import { BridgeError, bridgeRoot } from "./protocol.js";

// `phren pair` connects a phone in one scan. The QR code carries where to
// reach this computer, its SSH host key fingerprint and a one-time code. The
// phone makes its own key and posts the public half here with an HMAC keyed
// by the code, so the code itself never crosses the network; this computer
// answers with an HMAC over its fingerprint, which lets a phone that typed
// the code by hand trust the host key too. One success, five bad proofs or
// the time limit closes the listener.

const exec = promisify(execFile);
export const PAIR_PORT = 47291;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_FAILURES = 5;

export function newPairingCode(): string {
  return Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

/** Codes are typed as ABC-234 or abc234; both mean the same code. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function pairingProof(code: string, label: "phone" | "computer", ...parts: string[]): string {
  return createHmac("sha256", `phren-pair-v1:${normalizeCode(code)}`).update([label, ...parts].join("\n")).digest("base64url");
}

function sameProof(expected: string, received: string): boolean {
  const a = Buffer.from(expected), b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** OpenSSH's SHA256 fingerprint of a public key line, as the phone computes it. */
export function keyFingerprint(publicKeyLine: string): string | undefined {
  const blob = publicKeyLine.trim().split(/\s+/)[1];
  if (!blob) return undefined;
  return "SHA256:" + createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "");
}

export async function hostFingerprint(file = "/etc/ssh/ssh_host_ed25519_key.pub"): Promise<string | undefined> {
  return keyFingerprint(await readFile(file, "utf8").catch(() => ""));
}

/** Addresses the phone can try, best first: Tailscale name and address, then LAN IPv4. */
export async function pairingHosts(): Promise<string[]> {
  const hosts: string[] = [];
  for (const binary of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const { stdout } = await exec(binary, ["status", "--json", "--peers=false"], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
      const self = (JSON.parse(stdout) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } }).Self;
      if (self?.DNSName) hosts.push(self.DNSName.replace(/\.$/, ""));
      const ipv4 = self?.TailscaleIPs?.find(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      if (ipv4) hosts.push(ipv4);
      break;
    } catch { /* not installed here */ }
  }
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !hosts.includes(entry.address)) hosts.push(entry.address);
    }
  }
  return hosts.slice(0, 5);
}

/** The name people call this computer: macOS's Computer Name, else the host name. */
export async function computerDisplayName(): Promise<string> {
  if (process.platform === "darwin") {
    const name = await exec("scutil", ["--get", "ComputerName"], { timeout: 2000 }).then(({ stdout }) => stdout.trim()).catch(() => "");
    if (name) return name.slice(0, 64);
  }
  return hostname().replace(/\.local$/i, "").split(".")[0] || "Computer";
}

export interface PairingOffer {
  hosts: string[]; port: number; user: string; sshPort: number; fingerprint?: string; code: string; name: string;
}

/** The QR payload; the phone opens phren://pair links from the camera too. */
export function pairingURL(offer: PairingOffer): string {
  const query = new URLSearchParams({ v: "1", h: offer.hosts.join(","), p: String(offer.port), u: offer.user,
    s: String(offer.sshPort), c: offer.code, n: offer.name });
  if (offer.fingerprint) query.set("fp", offer.fingerprint);
  return `phren://pair?${query.toString()}`;
}

const request = z.object({
  v: z.literal(1), publicKey: z.string().max(512), proof: z.string().max(128),
  device: z.enum(["ios", "android"]).default("ios"), name: z.string().max(80).optional(),
});

export interface Paired { device: "ios" | "android"; name?: string; publicKey: string }

export interface PairingSession { port: number; done: Promise<Paired>; close(): void }

/** Listen for one phone. Resolves once its key is authorized; rejects on timeout or too many bad proofs. */
export async function startPairing(options: {
  code: string; user: string; sshPort: number; fingerprint?: string; name: string;
  port?: number; timeoutMs?: number; sshDirectory?: string;
}): Promise<PairingSession> {
  let failures = 0, finished = false, timer: NodeJS.Timeout | undefined;
  let resolve!: (paired: Paired) => void, reject!: (error: Error) => void;
  const done = new Promise<Paired>((yes, no) => { resolve = yes; reject = no; });
  const server = createServer((incoming, response) => { void handle(incoming, response); });
  const finish = (error?: Error, paired?: Paired) => {
    if (finished) return;
    finished = true; clearTimeout(timer); server.close();
    if (error) reject(error); else resolve(paired!);
  };
  const reply = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  };
  async function handle(incoming: IncomingMessage, response: ServerResponse) {
    try {
      if (finished) throw new BridgeError(410, "Pairing is closed. Run phren pair again.");
      if (incoming.method !== "POST" || incoming.url !== "/v1/pair") throw new BridgeError(404, "Not found.");
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of incoming) { size += chunk.length; if (size > 4096) throw new BridgeError(413, "Request is too large."); chunks.push(chunk); }
      const input = request.parse(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      const publicKey = publicComputerKey(input.publicKey);
      if (!sameProof(pairingProof(options.code, "phone", publicKey), input.proof)) {
        failures++;
        if (failures >= MAX_FAILURES) setImmediate(() => finish(new Error("Too many wrong pairing codes; pairing closed. Run phren pair again.")));
        throw new BridgeError(403, "That pairing code doesn't match this computer.");
      }
      const comment = input.device === "android" ? "phren-android" : "phren-iphone";
      const encoded = publicKey.split(" ")[1];
      await appendAuthorizedKey(`restrict,pty,${forcedCommand} ${publicKey} ${comment}`,
        existing => existing.split(/\s+/).includes(encoded), "This phone key is already authorized with different options.", options.sshDirectory);
      reply(response, 200, {
        v: 1, name: options.name, user: options.user, sshPort: options.sshPort, fingerprint: options.fingerprint ?? null,
        proof: pairingProof(options.code, "computer", options.fingerprint ?? "", publicKey),
      });
      setImmediate(() => finish(undefined, { device: input.device, name: input.name, publicKey }));
    } catch (error) {
      const status = error instanceof BridgeError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500;
      reply(response, status, { error: error instanceof z.ZodError ? "Invalid pairing request." : (error as Error).message });
    }
  }
  const listen = (port: number) => new Promise<number>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, () => { server.off("error", fail); ok((server.address() as { port: number }).port); });
  });
  let port: number;
  try { port = await listen(options.port ?? PAIR_PORT); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || options.port === 0) throw error;
    port = await listen(0);
  }
  timer = setTimeout(() => finish(new Error("Pairing timed out. Run phren pair again.")), options.timeoutMs ?? 5 * 60_000);
  return { port, done, close: () => finish(new Error("Pairing cancelled.")) };
}

async function sshListening(port: number): Promise<boolean> {
  return new Promise(ok => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 1500 });
    socket.once("connect", () => { socket.destroy(); ok(true); });
    socket.once("timeout", () => { socket.destroy(); ok(false); });
    socket.once("error", () => ok(false));
  });
}

function sshHint(): string {
  return process.platform === "darwin"
    ? "Turn on Remote Login: System Settings → General → Sharing → Remote Login."
    : "Start the SSH server, for example: sudo systemctl enable --now sshd";
}

export const PAIR_USAGE = "phren pair [--minutes <1-30>] [--port <n>] [--no-install]";

export async function runPair(args: string[], version: string): Promise<number> {
  let minutes = 5, port: number | undefined, installHook = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--minutes" && args[i + 1]) minutes = Number(args[++i]);
    else if (args[i] === "--port" && args[i + 1]) port = Number(args[++i]);
    else if (args[i] === "--no-install") installHook = false;
    else { console.error(`Usage: ${PAIR_USAGE}`); return 1; }
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30 || (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535))) {
    console.error(`Usage: ${PAIR_USAGE}`); return 1;
  }
  if (!["darwin", "linux"].includes(process.platform)) { console.error("Phone pairing supports macOS and Linux."); return 1; }
  if (installHook && !await lstat(path.join(bridgeRoot(), "installed.json")).catch(() => undefined)) {
    console.log("Installing Phren Hook, which your phone talks to…");
    await install(version);
  }
  const sshPort = 22;
  if (!await sshListening(sshPort)) console.log(`\n⚠ SSH isn't answering on this computer. ${sshHint()}\n  Pairing can finish now; the phone connects once SSH is on.`);
  const code = newPairingCode();
  const name = await computerDisplayName(), user = userInfo().username, fingerprint = await hostFingerprint();
  const hosts = await pairingHosts();
  if (!hosts.length) { console.error("No network address found. Connect to Wi-Fi or Tailscale and try again."); return 1; }
  const session = await startPairing({ code, user, sshPort, fingerprint, name, port, timeoutMs: minutes * 60_000 });
  const url = pairingURL({ hosts, port: session.port, user, sshPort, fingerprint, code, name });
  const { renderUnicodeCompact } = await import("uqr");
  console.log(`\nConnect your phone to ${name}`);
  console.log("  In the Phren app: Agents → Add computer → Scan pairing code\n");
  console.log(renderUnicodeCompact(url, { border: 2 }));
  const typed = `${code.slice(0, 3)}-${code.slice(3)}`;
  console.log(`\n  Can't scan? Choose "Enter code" and type:  ${hosts[0]}${session.port === PAIR_PORT ? "" : `:${session.port}`}   ${typed}`);
  console.log(`  Waiting for your phone (${minutes} min). Ctrl-C cancels.`);
  const cancel = () => session.close();
  process.once("SIGINT", cancel);
  try {
    const paired = await session.done;
    console.log(`\n✓ Paired ${paired.name ?? "your phone"}. It can reach Phren Hook on ${name} as ${user}.`);
    console.log(`  To revoke it later, remove its ${paired.device === "android" ? "phren-android" : "phren-iphone"} line from ${path.join(homedir(), ".ssh/authorized_keys")}.`);
    return 0;
  } catch (error) {
    console.error(`\n${(error as Error).message}`);
    return 1;
  } finally { process.off("SIGINT", cancel); }
}
