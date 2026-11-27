import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerOptions, ServerResponse } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { AgentHooks } from "./agent-hooks.js";
import { BrowserRegistry } from "./browser-registry.js";
import * as herdr from "./herdr.js";
import { OwnerInbox } from "./owner-inbox.js";
import * as peerReads from "./peer-reads.js";
import * as peers from "./peers.js";
import { ApprovalPushService } from "./push.js";
import { serve } from "./server.js";
import { StaleTaskSources } from "./task-stale.js";

// Use serve's actual request handler and intervals without a listening socket.
const http = vi.hoisted(() => ({ handler: undefined as RequestListener | undefined }));
vi.mock("node:http", async importOriginal => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, createServer: (options: ServerOptions, handler: RequestListener) => {
    http.handler = handler;
    const server = actual.createServer(options, handler);
    server.listen = ((file: string, ready: () => void) => {
      void writeFile(file, "").then(ready, error => server.emit("error", error));
      return server;
    }) as typeof server.listen;
    return server;
  } };
});

const AT = Date.parse("2026-11-27T10:00:00.000Z");
const DEVICE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REMOTE = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", title: "Peer-only item", kind: "manual", state: "open",
  createdAt: new Date(AT).toISOString(), updatedAt: new Date(AT).toISOString(),
};

function inboxRead(query: string, peer = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = Readable.from([]) as IncomingMessage;
    req.method = "GET";
    req.url = `/v1/owner-inbox?${query}`;
    req.headers = peer ? { "x-phren-origin": "peer" } : {};
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body: string) {
        if (this.statusCode !== 200) return reject(new Error(`Inbox read returned ${this.statusCode}: ${body}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      },
    };
    http.handler!(req, res as unknown as ServerResponse);
  });
}

it("sends a CLI add made in the ledger's initialization millisecond with an origin/main peer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inbox-"));
  const ledgerFile = path.join(root, "owner-inbox-push.json");
  const previousUmask = process.umask();
  const previousSignals = process.listeners("SIGTERM");
  const stop = () => process.listeners("SIGTERM").find(listener => !previousSignals.includes(listener));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  const store = path.join(root, "store");
  const config = path.join(store, ".config");
  await mkdir(config, { recursive: true });
  await writeFile(path.join(config, "modules.yaml"), "version: 1\nenabled: { hook: true, conductor: true, tasks: true }\n");
  vi.stubEnv("PHREN_PATH", store);
  vi.stubEnv("PHREN_OWNER_INBOX_BACKFILL_ID", undefined);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(AT);
  vi.spyOn(herdr, "recentServers").mockResolvedValue([]);
  vi.spyOn(AgentHooks.prototype, "start").mockResolvedValue(undefined);
  vi.spyOn(BrowserRegistry.prototype, "start").mockResolvedValue(undefined);
  const legacyPeer = {
    name: "000-legacy", address: "legacy.invalid", username: "owner", port: 22, hostKey: "fixture", server: "default",
  };
  vi.spyOn(peers, "hookPeers").mockResolvedValue([legacyPeer]);
  const readPeerConfig = vi.spyOn(peers, "optionalHookPeers").mockResolvedValue({ peers: [legacyPeer] });
  // origin/main serves Inbox reads and has no Inbox push capability.
  vi.spyOn(peerReads, "peerRead").mockResolvedValue({ ok: true, items: [REMOTE] });
  const staleTask = { kind: "needs-you", title: "Stale shared task", source: "task-stale:phren:1234abcd" } as const;
  const staleSources = vi.spyOn(StaleTaskSources.prototype, "sources").mockReturnValue([]);
  const devices = vi.spyOn(ApprovalPushService.prototype, "ownerInboxPushDevices").mockReturnValue([]);
  const sent = vi.spyOn(ApprovalPushService.prototype, "notifyOwnerInbox").mockResolvedValue(true);
  const serving = serve("test");
  let startupError: unknown;
  void serving.catch(error => { startupError = error; });

  const readLedger = async () => JSON.parse(await readFile(ledgerFile, "utf8")) as { initializedAt: string; entries: unknown[] };
  try {
    await vi.waitFor(() => {
      if (startupError) throw startupError;
      expect(stop()).toBeDefined();
    });
    // Let the actual interval initialize the ledger before adding any rows.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(async () => expect(await readLedger()).toMatchObject({ entries: [] }));
    const { initializedAt } = await readLedger();
    vi.setSystemTime(new Date(initializedAt));

    const cliInbox = new OwnerInbox(async () => [], path.join(root, "owner-inbox.json"));
    const { item } = await cliInbox.run({ action: "add", title: "OVH US VPS-2 is in stock" });
    expect(item).toMatchObject({ createdAt: initializedAt });
    const { id, title } = item as { id: string; title: string };
    devices.mockReturnValue([DEVICE]);
    staleSources.mockReturnValue([staleTask]);

    // Both a peer fetching this Hook's list and a phone's aggregate read see
    // open rows before the next tick. Neither read may enqueue or send.
    expect(await inboxRead("local=1&compact=1&reconcile=1", true)).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id, title })]),
    });
    expect(await inboxRead("compact=1")).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id, inboxComputer: "local" }),
        expect.objectContaining({ title: staleTask.title, inboxComputer: "local" }),
        expect.objectContaining({ id: REMOTE.id, inboxComputer: legacyPeer.name }),
      ]),
    });
    expect(sent).not.toHaveBeenCalled();
    expect(await readLedger()).toMatchObject({ entries: [] });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(async () => expect(await readLedger()).toMatchObject({
      entries: [{ id, sentDeviceIDs: [DEVICE] }],
    }));
    expect(readPeerConfig).not.toHaveBeenCalled();
    expect(sent).toHaveBeenCalledExactlyOnceWith({ id, title, expiresAt: expect.any(String) }, DEVICE);
  } finally {
    const shutdown = stop();
    if (shutdown) {
      shutdown("SIGTERM");
      await serving;
    }
    process.umask(previousUmask);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
