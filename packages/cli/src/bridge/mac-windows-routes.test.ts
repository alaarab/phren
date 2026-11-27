import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { BUILTIN_MODULES } from "../modules/registry.js";
import * as herdr from "./herdr.js";
import * as nativeHelpers from "./native-helpers.js";
import { OWNER_PROOF_HEADER } from "./owner-proof.js";
import * as macWindows from "./mac-windows.js";
import { resetMacWindowsState, setMacWindowsDeps, setMacWindowsEnabled } from "./mac-windows.js";
import type { Json } from "./protocol.js";
import { serve } from "./server.js";
import { SOCKETS_PER_KIND } from "./socket-budget.js";

/** The real route handler: every Mac window route is owner-only, peer or MCP origin or not. */

const { capabilitiesForModules, createRouteHandler } = await import("./server-routes.js");

const modules = { has: () => true, modules: BUILTIN_MODULES };
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-mw-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

/** A paired-phone key and the signed envelope the Hook verifies. */
const phone = generateKeyPairSync("ed25519");
const phoneRaw = phone.publicKey.export({ format: "der", type: "spki" }).subarray(12);
const PHONE_WIRE = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), phoneRaw]);
const AUTHORIZED_KEYS = `restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ssh-ed25519 ${PHONE_WIRE.toString("base64")} phren-iphone\n`;
function proofHeader(method: string, pathname: string, body: string): string {
  const payload = Buffer.from(JSON.stringify({
    domain: "phren-owner-request-v1", nonce: randomUUID(), at: new Date().toISOString(),
    method, path: pathname, body: createHash("sha256").update(body).digest("hex"),
  }));
  return Buffer.from(JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, phone.privateKey).toString("base64"),
    publicKey: phoneRaw.toString("base64") })).toString("base64url");
}

async function request(method: string, url: string, body?: Json, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const handler = createRouteHandler({ modules, info: { computer: { id: "00000000-0000-4000-8000-0000000000aa", name: "self" }, capabilities: capabilitiesForModules(modules as never) },
    accountUsage: { read: async () => ({ accounts: [] }) }, streams: {} } as never);
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as IncomingMessage;
  req.method = method; req.url = url; req.headers = headers;
  let payload = "";
  const res = { statusCode: 200, setHeader() {}, end(value: string) { payload = value; } };
  await handler(req, res as unknown as ServerResponse);
  return { status: res.statusCode, body: payload ? JSON.parse(payload) as Json : {} };
}

describe("mac window routes refuse agents and peers", () => {
  const cases: { method: string; url: string; body?: Json; headers: Record<string, string> }[] = [
    { method: "GET", url: "/v1/mac/windows", headers: { "x-phren-origin": "peer" } },
    { method: "GET", url: "/v1/mac/windows", headers: { "x-phren-origin": "agent" } },
    { method: "GET", url: "/v1/mac/windows/snapshot?id=7", headers: { "x-phren-origin": "peer" } },
    { method: "GET", url: "/v1/mac/windows/snapshot?id=7", headers: { "x-phren-origin": "agent" } },
    { method: "POST", url: "/v1/mac/windows/action", body: { id: 7, action: "raise" }, headers: { "x-phren-origin": "peer" } },
    { method: "POST", url: "/v1/mac/windows/action", body: { id: 7, action: "raise", origin: { pane: "1" } }, headers: {} },
    { method: "POST", url: "/v1/mac/windows/permissions", body: { permission: "accessibility" }, headers: { "x-phren-origin": "peer" } },
    { method: "POST", url: "/v1/mac/windows/permissions", body: { permission: "accessibility", origin: { pane: "1" } }, headers: {} },
  ];
  it.each(cases)("$method $url with $headers", async ({ method, url, body, headers }) => {
    const answer = await request(method, url, body, headers);
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ code: "mac-windows-owner-only" });
  });
});

describe("signed Mac window requests", () => {
  let home: string;
  const restores: (() => void)[] = [];
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "phren-mac-windows-home-"));
    vi.stubEnv("HOME", home);
    await mkdir(path.join(home, ".ssh"), { recursive: true });
    await writeFile(path.join(home, ".ssh", "authorized_keys"), AUTHORIZED_KEYS);
    resetMacWindowsState();
    restores.push(setMacWindowsDeps({
      platform: () => "darwin",
      release: () => "23.6.0",
      pollMs: () => 3_600_000,
      run: async () => ({ stdout: Buffer.alloc(0), stderr: "", code: 0 }),
      spawnBadge: async () => ({ ready: Promise.resolve(), kill() {}, onExit() {} }),
    }));
  });
  afterEach(async () => {
    while (restores.length) restores.pop()?.();
    resetMacWindowsState();
    await rm(home, { recursive: true, force: true });
  });

  it("accepts a correctly signed GET and refuses an unsigned one", async () => {
    const unsigned = await request("GET", "/v1/mac/windows");
    expect(unsigned.status).toBe(403);
    expect(unsigned.body).toMatchObject({ code: "owner-proof-required" });
    const signed = await request("GET", "/v1/mac/windows", undefined, { [OWNER_PROOF_HEADER]: proofHeader("GET", "/v1/mac/windows", "") });
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ enabled: false, windows: [] });
  });

  it("refuses the action with 503 when the admission row cannot be written", async () => {
    await setMacWindowsEnabled(true);
    await writeFile(path.join(root, "mac-windows"), "not a folder");
    const body = { id: 7, action: "raise" };
    const answer = await request("POST", "/v1/mac/windows/action", body,
      { [OWNER_PROOF_HEADER]: proofHeader("POST", "/v1/mac/windows/action", JSON.stringify(body)) });
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ code: "mac-windows-audit" });
  });

  it("keeps success when the completion row cannot be written after the input ran", async () => {
    await setMacWindowsEnabled(true);
    // The helper breaks the log folder between the admission row and the completion row.
    restores.push(setMacWindowsDeps({ run: async call => {
      if (call.args[0] === "raise") {
        await rm(path.join(root, "mac-windows"), { recursive: true, force: true });
        await writeFile(path.join(root, "mac-windows"), "");
      }
      return { stdout: Buffer.alloc(0), stderr: "", code: 0 };
    } }));
    const body = { id: 7, action: "raise" };
    const answer = await request("POST", "/v1/mac/windows/action", body,
      { [OWNER_PROOF_HEADER]: proofHeader("POST", "/v1/mac/windows/action", JSON.stringify(body)) });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true });
  });

  describe.skipIf(process.platform === "win32")("real Hook upgrades", () => {
    const streamPath = "/v1/mac/windows/stream";
    const clients: WebSocket[] = [];
    let serving: Promise<void>;
    let stop: NodeJS.SignalsListener | undefined;
    let umask: number;

    function connect(url: string, headers: Record<string, string> = {}): WebSocket {
      const client = new WebSocket(`ws+unix:${root}/hook.sock:${url}`, { headers });
      client.on("error", () => {});
      clients.push(client);
      return client;
    }

    async function refusedUpgrade(headers: Record<string, string> = {}, url = `${streamPath}?id=12345`): Promise<number | undefined> {
      const client = connect(url, headers);
      return new Promise((resolve, reject) => {
        client.once("unexpected-response", (_request, response) => {
          response.resume();
          resolve(response.statusCode);
        });
        client.once("open", () => reject(new Error("Refused request received 101")));
        client.once("error", reject);
      });
    }

    const signed = () => ({ [OWNER_PROOF_HEADER]: proofHeader("GET", streamPath, "") });
    const auditRows = async (): Promise<Json[]> => {
      const data = await readFile(path.join(root, "mac-windows", "sessions.jsonl"), "utf8");
      return data.trim().split("\n").map(line => JSON.parse(line) as Json);
    };

    beforeEach(async () => {
      vi.stubEnv("PHREN_PATH", path.join(home, "store"));
      vi.stubEnv("PHREN_HERDR_HOME", path.join(home, "herdr"));
      // Let overview connections exercise the real socket budget without Herdr.
      vi.spyOn(herdr, "sharedSnapshot").mockImplementation(() => new Promise(() => {}));
      umask = process.umask();
      const signals = process.listeners("SIGTERM");
      serving = serve("test");
      void serving.catch(() => {});
      await vi.waitFor(() => {
        stop = process.listeners("SIGTERM").find(listener => !signals.includes(listener));
        expect(stop).toBeDefined();
      });
    });

    afterEach(async () => {
      try {
        if (stop) {
          stop("SIGTERM");
          stop = undefined;
        }
        for (const client of clients.splice(0)) client.terminate();
        await serving;
      } finally {
        process.umask(umask);
        vi.restoreAllMocks();
      }
    });

    it("requires proof and unmarked origin before HTTP 101 or socket-budget admission", async () => {
      const oldest = connect("/v1/overview");
      await once(oldest, "open");
      const rest = Array.from({ length: SOCKETS_PER_KIND - 1 }, () => connect("/v1/overview"));
      const evictions: [number, string][] = [];
      for (const client of [oldest, ...rest]) client.on("close", (code, why) => evictions.push([code, String(why)]));
      await Promise.all(rest.map(client => once(client, "open")));

      expect(await refusedUpgrade()).toBe(403);
      expect(await refusedUpgrade({ [OWNER_PROOF_HEADER]: "invalid" })).toBe(403);
      expect(await refusedUpgrade({ ...signed(), "x-phren-origin": "agent" })).toBe(403);
      expect(await refusedUpgrade({ ...signed(), "x-phren-origin": "peer" })).toBe(403);
      expect(evictions).toEqual([]);
      const rows = await auditRows();
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row).toMatchObject({ action: "stream-start", ok: false, error: "mac-windows-owner-only" });
        expect(row).not.toHaveProperty("windowId");
      }

      const signedClient = connect(`${streamPath}?id=7`, signed());
      const closed = once(signedClient, "close");
      const evicted = once(oldest, "close");
      await once(signedClient, "open");
      const [code, reason] = await closed;
      expect([code, String(reason)]).toEqual([1008, "mac-windows-disabled"]);
      const [evictionCode, evictionReason] = await evicted;
      expect([evictionCode, String(evictionReason)]).toEqual([1008, "Too many connections; reconnect"]);
    });

    it("checks macOS 14 after authentication and before parsing a malformed query", async () => {
      restores.push(setMacWindowsDeps({ release: () => "22.6.0" }));
      expect(await refusedUpgrade({}, `${streamPath}?bad=1`)).toBe(403);
      const client = connect(`${streamPath}?bad=1`, signed());
      const [code, reason] = await once(client, "close");
      expect([code, String(reason)]).toEqual([1008, "unsupported-platform"]);
    });

    it("closes the lease with shutdown before killing the badge in the Hook signal handler", async () => {
      await setMacWindowsEnabled(true);
      const close = vi.spyOn(WebSocket.prototype, "close");
      const stopSession = vi.spyOn(macWindows, "stopMacWindows");
      const closedBeforeBadge = vi.fn();
      restores.push(setMacWindowsDeps({
        spawnBadge: async () => ({ ready: Promise.resolve(), onExit() {}, kill() {
          closedBeforeBadge(close.mock.calls.some(([code, reason]) => code === 1001 && reason === "shutdown"));
        } }),
      }));
      let releaseHelper: ((binary: string) => void) | undefined;
      vi.spyOn(nativeHelpers, "verifiedHelper").mockImplementationOnce(() =>
        new Promise<string>(resolve => { releaseHelper = resolve; }));
      const client = connect(`${streamPath}?id=7`, signed());
      const closed = once(client, "close");
      await vi.waitFor(() => expect(releaseHelper).toBeTypeOf("function"));
      const signal = stop!;
      stop = undefined;
      try {
        signal("SIGTERM");
        const closeIndex = close.mock.calls.findIndex(([code, reason]) => code === 1001 && reason === "shutdown");
        expect(close.mock.invocationCallOrder[closeIndex]).toBeGreaterThan(stopSession.mock.invocationCallOrder[0]);
        expect(closedBeforeBadge).toHaveBeenCalledExactlyOnceWith(true);
        const [code, reason] = await closed;
        expect([code, String(reason)]).toEqual([1001, "shutdown"]);
        await vi.waitFor(async () => {
          expect((await auditRows()).filter(row => row.action === "stream-end")).toEqual([
            expect.objectContaining({ windowId: 7, ok: false, error: "shutdown" }),
          ]);
        });
      } finally {
        releaseHelper?.("/unused");
      }
    });
  });
});
