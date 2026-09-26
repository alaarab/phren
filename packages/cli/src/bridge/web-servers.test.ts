import { randomUUID } from "node:crypto";
import { createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// execFile is promisified at module load, so the mock has to be in place first
// and answer with the (error, { stdout }) callback shape promisify expects.
const execFileMock = vi.fn();
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { webServers } = await import("./projects.js");

type Answer = { stdout: string } | Error;
function answer(byTool: Record<string, Answer>) {
  execFileMock.mockImplementation((file: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    const tool = file.endsWith("lsof") ? "lsof" : file;
    const reply = byTool[tool] ?? Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
    if (reply instanceof Error) callback(reply); else callback(null, { stdout: reply.stdout, stderr: "" });
    return { on() {} };
  });
}

/** Listens on 127.0.0.1:`port` (0 lets the OS pick) and confirms, by a request
 * that must come back with this server's nonce, that the address reaches this
 * server. macOS lets a 127.0.0.1 bind succeed beside another process's listener
 * on the same port, so a successful listen alone does not prove the probe in
 * webServers() will land here. */
async function listenOwned(server: Server, nonce: string, port: number): Promise<number | undefined> {
  const listening = await new Promise<boolean>(resolve => {
    const fail = () => resolve(false);
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => { server.off("error", fail); resolve(true); });
  });
  if (!listening) return undefined;
  const bound = (server.address() as AddressInfo).port;
  const owned = await new Promise<boolean>(resolve => {
    get({ host: "127.0.0.1", port: bound, path: "/", agent: false, timeout: 2_000 }, res => {
      res.resume(); resolve(res.headers["x-test-nonce"] === nonce);
    }).on("error", () => resolve(false)).on("timeout", () => resolve(false));
  });
  if (owned) return bound;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return undefined;
}

/** A port below the ephemeral range, which the ordering test needs. */
async function listenBelowEphemeral(server: Server, nonce: string): Promise<number | undefined> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await listenOwned(server, nonce, 20_000 + Math.floor(Math.random() * 10_000));
    if (port) return port;
  }
  return undefined;
}

const ssLine = (port: number, name = "node", pid = 1) =>
  `LISTEN 0 511 *:${port} *:* users:(("${name}",pid=${pid},fd=20))`;

describe("webServers", () => {
  let server: Server;
  let port = 0;
  beforeEach(async context => {
    const nonce = randomUUID();
    server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html"); res.setHeader("x-test-nonce", nonce);
      res.end("<html><title>Alastack &amp; Co</title></html>");
    });
    // Only the ordering test needs a port below the ephemeral range; the others
    // take the OS's pick, which no other socket can already hold.
    const bound = context.task.name.startsWith("probes well-known ports")
      ? await listenBelowEphemeral(server, nonce)
      : await listenOwned(server, nonce, 0);
    if (!bound) throw new Error("could not listen on a port this test owns");
    port = bound;
  });
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    execFileMock.mockReset();
  });

  it("reads listeners from ss when lsof is not installed", async () => {
    answer({ ss: { stdout: `${ssLine(port, "bun", 42)}\n` } });
    const found = await webServers();
    expect(found).toEqual([{ name: "Alastack & Co", port, origin: `http://127.0.0.1:${port}`, process: "bun", pid: 42 }]);
  });

  it("falls back to lsof when ss is missing", async () => {
    answer({ lsof: { stdout: `p42\ncbun\nn*:${port}\n` } });
    const found = await webServers();
    expect(found).toEqual([{ name: "Alastack & Co", port, origin: `http://127.0.0.1:${port}`, process: "bun", pid: 42 }]);
  });

  it("probes well-known ports before ephemeral ones so a browser cannot crowd out a dev server", async () => {
    // 80 ephemeral listeners listed first, the real server last: the old
    // pid-ordered slice(0, 64) would never have probed it.
    const noise = Array.from({ length: 80 }, (_, i) => ssLine(40_000 + i, "chrome", 1000 + i));
    const listeners = [...noise, ssLine(port, "bun", 42)];
    answer({ ss: { stdout: listeners.join("\n") } });
    const found = await webServers();
    expect(found.map(server => server.port)).toContain(port);
  });

  it("reports a clear error when neither tool exists", async () => {
    answer({});
    await expect(webServers()).rejects.toThrow(/install lsof/);
  });
});
