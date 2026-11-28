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

function inboxPost(body: unknown, query = ""): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
    req.method = "POST";
    req.url = `/v1/owner-inbox${query ? `?${query}` : ""}`;
    req.headers = {};
    const res = {
      statusCode: 200,
      setHeader() {},
      end(raw: string) {
        if (this.statusCode !== 200) return reject(new Error(`Inbox write returned ${this.statusCode}: ${raw}`));
        try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
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
  await writeFile(path.join(config, "modules.yaml"), "version: 1\nenabled: { hook: true, conductor: true }\n");
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

    // Both a peer fetching this Hook's list and a phone's aggregate read see
    // open rows before the next tick. Neither read may enqueue or send.
    expect(await inboxRead("local=1&compact=1&reconcile=1", true)).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id, title })]),
    });
    expect(await inboxRead("compact=1")).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id, inboxComputer: "local" }),
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

it("adds and lists an issue link, and hides the field from a reader that does not ask", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "inbox-issue-"));
  const previousSignals = process.listeners("SIGTERM");
  const stop = () => process.listeners("SIGTERM").find(listener => !previousSignals.includes(listener));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  const store = path.join(root, "store"), config = path.join(store, ".config");
  await mkdir(config, { recursive: true });
  await writeFile(path.join(config, "modules.yaml"), "version: 1\nenabled: { hook: true, conductor: true }\n");
  vi.stubEnv("PHREN_PATH", store);
  vi.stubEnv("PHREN_OWNER_INBOX_BACKFILL_ID", undefined);
  vi.spyOn(herdr, "recentServers").mockResolvedValue([]);
  vi.spyOn(AgentHooks.prototype, "start").mockResolvedValue(undefined);
  vi.spyOn(BrowserRegistry.prototype, "start").mockResolvedValue(undefined);
  vi.spyOn(peers, "hookPeers").mockResolvedValue([]);
  vi.spyOn(peerReads, "peerRead").mockResolvedValue({ ok: true, items: [] });
  vi.spyOn(ApprovalPushService.prototype, "ownerInboxPushDevices").mockReturnValue([]);
  const serving = serve("test");
  let startupError: unknown;
  void serving.catch(error => { startupError = error; });
  try {
    await vi.waitFor(() => {
      if (startupError) throw startupError;
      expect(stop()).toBeDefined();
    });
    const issue = "github.com/alaarab/phren#42";
    const added = await inboxPost({ action: "add", title: "Rotate the deploy key", issue }, "issues=1");
    expect(added).toMatchObject({ ok: true, item: { title: "Rotate the deploy key", issue } });
    // A reader that asks for it gets the structured link, locally and through a peer's query flag.
    expect(await inboxRead("local=1&issues=1")).toMatchObject({ items: [{ title: "Rotate the deploy key", issue }] });
    expect(await inboxPost({ action: "list" }, "issues=1")).toMatchObject({ items: [{ title: "Rotate the deploy key", issue }] });
    // Every older strict reader gets the link in the title and no unknown key.
    for (const reply of [await inboxRead("local=1"), await inboxRead("local=1&compact=1&reconcile=1", true), await inboxPost({ action: "list" })]) {
      expect(reply).toMatchObject({ items: [{ title: "Rotate the deploy key (issue: github.com/alaarab/phren#42)" }] });
      expect("issue" in ((reply as { items: Record<string, unknown>[] }).items[0])).toBe(false);
    }
    // The stored row carries the link only in its title.
    const stored = JSON.parse(await readFile(path.join(root, "owner-inbox.json"), "utf8"));
    expect(stored).toEqual([expect.objectContaining({ title: "Rotate the deploy key (issue: github.com/alaarab/phren#42)" })]);
    expect("issue" in (stored[0] as object)).toBe(false);
  } finally {
    const shutdown = stop();
    if (shutdown) {
      shutdown("SIGTERM");
      await serving;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
