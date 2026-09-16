import { createServer, type Server } from "node:http";
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

async function listenBelowEphemeral(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = 20_000 + Math.floor(Math.random() * 10_000);
    const ok = await new Promise<boolean>(resolve => {
      server.once("error", () => resolve(false));
      server.listen(candidate, "127.0.0.1", () => resolve(true));
    });
    if (ok) return candidate;
  }
  throw new Error("no free port below the ephemeral range");
}

const ssLine = (port: number, name = "node", pid = 1) =>
  `LISTEN 0 511 *:${port} *:* users:(("${name}",pid=${pid},fd=20))`;

describe("webServers", () => {
  let server: Server;
  let port = 0;
  beforeEach(async () => {
    server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<html><title>Alastack &amp; Co</title></html>"); });
    // A port below the ephemeral range, so the ordering test is deterministic.
    port = await listenBelowEphemeral(server);
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
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
    expect(found.map(server => server.port)).toEqual([port]);
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
