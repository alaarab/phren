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

let webServers: typeof import("./projects.js").webServers;

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
    vi.resetModules();
    ({ webServers } = await import("./projects.js"));
    const nonce = randomUUID();
    server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html"); res.setHeader("x-test-nonce", nonce);
      res.end("<html><title>Acme &amp; Co</title></html>");
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
    vi.useRealTimers();
    execFileMock.mockReset();
    vi.restoreAllMocks();
  });

  it("reads listeners from ss when lsof is not installed", async () => {
    answer({ ss: { stdout: `${ssLine(port, "bun", 42)}\n` } });
    const found = await webServers();
    expect(found).toEqual([{ name: "Acme & Co", port, origin: `http://127.0.0.1:${port}`, process: "bun", pid: 42 }]);
  });

  it("drops a cached listener that no longer holds its port, even if its process still runs", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    answer({ ss: { stdout: `${ssLine(port, "bun", 42)}\n` } });
    expect(await webServers()).toMatchObject([{ port, pid: 42 }]);
    // Session A's process closes the listener but keeps running; B's server takes the port inside the cache's ten seconds.
    now += 2_000;
    answer({ ss: { stdout: `${ssLine(port, "bun", 77)}\n` } });
    expect(await webServers()).toEqual([]);
    // The cache was refreshed, not just filtered: B's server shows up with its own pid.
    expect(await webServers()).toMatchObject([{ port, pid: 77 }]);
  });
  it("keeps a cached listener the socket table still shows with the same owner", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    answer({ ss: { stdout: `${ssLine(port, "bun", 42)}\n` } });
    expect(await webServers()).toMatchObject([{ port, pid: 42 }]);
    now += 2_000;
    expect(await webServers()).toMatchObject([{ port, pid: 42 }]);
  });
  it("spells the port out in a listener's key, default ports included", async () => {
    const { listenerKey } = await import("./projects.js");
    // A URL's host drops :80 and :443, but the socket table's keys never do.
    expect(listenerKey({ origin: "http://127.0.0.1:80", port: 80 })).toBe("127.0.0.1:80");
    expect(listenerKey({ origin: "http://[::1]:443", port: 443 })).toBe("[::1]:443");
    expect(listenerKey({ origin: `http://127.0.0.1:${port}`, port })).toBe(`127.0.0.1:${port}`);
  });
  it("trusts a listing only as far as its scan began, not as far as its probes finished", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    answer({ ss: { stdout: `${ssLine(port, "bun", 42)}\n` } });
    const scan = webServers();
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalled());
    // Probing takes a while: the scan "finishes" 5 s after it read the socket table.
    now += 5_000;
    expect(await scan).toMatchObject([{ port, pid: 42 }]);
    // Meanwhile A closed its listener and B took the port.
    answer({ ss: { stdout: `${ssLine(port, "bun", 77)}\n` } });
    expect(await webServers()).toEqual([]);
  });
  it("falls back to lsof when ss is missing", async () => {
    answer({ lsof: { stdout: `p42\ncbun\nn*:${port}\n` } });
    const found = await webServers();
    expect(found).toEqual([{ name: "Acme & Co", port, origin: `http://127.0.0.1:${port}`, process: "bun", pid: 42 }]);
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

  it("shares cold scans and serves cached listeners while one stale refresh runs", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let complete!: (includeServer?: boolean) => void;
    execFileMock.mockImplementation((file: string, _args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
      complete = (includeServer = false) => callback(null, { stdout: includeServer
        ? (file.endsWith("lsof") ? `p42\ncbun\nn*:${port}\n` : ssLine(port, "bun", 42)) : "", stderr: "" });
      return { on() {} };
    });
    const cold = [webServers(), webServers()];
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(1));
    complete();
    expect(await Promise.all(cold)).toEqual([[], []]);
    expect(await webServers()).toEqual([]);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    now += 10_001;
    expect(await webServers()).toEqual([]);
    expect(await webServers()).toEqual([]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    complete(true);
    await vi.waitFor(async () => expect(await webServers()).toMatchObject([{ port, name: "Acme & Co" }]));
    now += 300_001;
    let settled = false;
    const expired = webServers().then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(3));
    expect(settled).toBe(false);
    complete();
    expect(await expired).toEqual([]);
  });

  it("expires a stalled scan after twenty seconds so the next poll can retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const completions: Array<(error: Error | null, result: { stdout: string; stderr: string }) => void> = [];
    execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: typeof completions[number]) => {
      completions.push(callback);
      return { on() {} };
    });
    const read = webServers();
    const rejected = expect(read).rejects.toThrow(/time limit/);
    await vi.advanceTimersByTimeAsync(20_001);
    await rejected;
    const next = webServers();
    await vi.advanceTimersByTimeAsync(0);
    completions[1](null, { stdout: "", stderr: "" });
    expect(await next).toEqual([]);
    completions[0](null, { stdout: "", stderr: "" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await webServers()).toEqual([]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("bounds a probe even when HTTP 102 responses keep the socket active", async () => {
    server.removeAllListeners("request");
    const intervals = new Set<ReturnType<typeof setInterval>>();
    server.on("request", (_req, res) => {
      const interval = setInterval(() => res.writeProcessing(), 100);
      intervals.add(interval);
      res.on("close", () => { clearInterval(interval); intervals.delete(interval); });
    });
    answer({ ss: { stdout: ssLine(port) }, lsof: { stdout: `p42\ncbun\nn*:${port}\n` } });
    try {
      expect(await Promise.race([
        webServers(),
        new Promise(resolve => setTimeout(() => resolve("stalled"), 2_500)),
      ])).toEqual([]);
    } finally {
      for (const interval of intervals) clearInterval(interval);
      server.closeAllConnections();
    }
  });

  it("retries a failed scan without caching its error", async () => {
    answer({});
    await expect(webServers()).rejects.toThrow(/install lsof/);
    answer({ ss: { stdout: "" }, lsof: { stdout: "" } });
    expect(await webServers()).toEqual([]);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("reports a clear error when neither tool exists", async () => {
    answer({});
    await expect(webServers()).rejects.toThrow(/install lsof/);
  });
});
