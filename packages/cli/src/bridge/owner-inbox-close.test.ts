import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeError } from "./protocol.js";
import { bodyDigest, OWNER_PROOF_HEADER } from "./owner-proof.js";
import { createRouteHandler, capabilitiesForModules, ownerInboxCloseSchema } from "./server-routes.js";
import type { OwnerInbox } from "./owner-inbox.js";

const state = vi.hoisted(() => ({ home: "" }));
vi.mock("../home-paths.js", async original => ({
  ...(await original<typeof import("../home-paths.js")>()), homeDir: () => state.home,
}));

const AT = "2026-11-27T10:00:00.000Z";
const ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ROW = { id: ID, kind: "manual", title: "OVH US VPS-2 is in stock", state: "open", createdAt: AT, updatedAt: AT, project: "phren" };

/** A paired phone: the key it signs with, and the authorized_keys line that makes it a device. */
function phone() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const wire = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), raw]);
  return {
    privateKey, raw: raw.toString("base64"),
    authorizedKeys: `restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ssh-ed25519 ${wire.toString("base64")} phren-iphone\n`,
  };
}

type Phone = ReturnType<typeof phone>;
function proof(device: Phone, raw: string, pathname = "/v1/owner-inbox/close") {
  const payload = Buffer.from(JSON.stringify({
    domain: "phren-owner-request-v1", nonce: randomUUID(), at: new Date().toISOString(),
    method: "POST", path: pathname, body: bodyDigest(Buffer.from(raw)),
  }));
  return Buffer.from(JSON.stringify({
    payload: payload.toString("base64"), signature: sign(null, payload, device.privateKey).toString("base64"), publicKey: device.raw,
  })).toString("base64url");
}

const snapshot = {
  store: "/store", profile: "work", generation: "test",
  // requireRoute finds the conductor module by its route table, then asks has().
  has: (name: string) => name === "conductor",
  modules: [{ name: "conductor", capabilities: ["ownerInbox"] }],
};

let root: string, owner: Phone, inbox: { close: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> };
let confirmed = 0;

async function call(pathname: string, method: string, payload?: unknown, headers: Record<string, string> = {}) {
  const handler = createRouteHandler({
    modules: snapshot, info: { computer: { id: "computer-1", name: "Test" } }, inbox: inbox as unknown as OwnerInbox,
    streams: {}, agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set(), ownerConfirms: { confirm: async () => { confirmed++; } } },
    journal: { record: async () => {} }, tabActivity: { observe: async () => ({ generation: 0, stamps: new Map() }), recordStatus: async () => new Map() },
    contextUsage: { read: async () => new Map() },
  } as never);
  const raw = payload === undefined ? "" : JSON.stringify(payload);
  let responseBody = "";
  const response = { statusCode: 200, setHeader() {}, end(value: string) { responseBody = value; } };
  await handler({
    url: pathname, method, headers,
    [Symbol.asyncIterator]: async function* () { if (payload !== undefined) yield Buffer.from(raw); },
  } as unknown as IncomingMessage, response as unknown as ServerResponse);
  return { status: response.statusCode, data: JSON.parse(responseBody), raw };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "owner-inbox-close-"));
  state.home = path.join(root, "home");
  process.env.PHREN_BRIDGE_HOME = path.join(root, "bridge");
  owner = phone();
  await mkdir(path.join(state.home, ".ssh"), { recursive: true });
  await writeFile(path.join(state.home, ".ssh", "authorized_keys"), owner.authorizedKeys);
  confirmed = 0;
  inbox = {
    close: vi.fn(async (_id: string, _ifUpdatedAt: string, decision: "resolve" | "dismiss") => ({
      ...ROW, state: "resolved", updatedAt: "2026-11-27T10:05:00.000Z", resolvedAt: "2026-11-27T10:05:00.000Z",
      resolution: decision === "resolve" ? "done" : "dismissed",
    })),
    run: vi.fn(async () => ({ ok: true, items: [ROW] })),
  };
});
afterEach(async () => {
  delete process.env.PHREN_BRIDGE_HOME;
  await rm(root, { recursive: true, force: true });
});

describe("POST /v1/owner-inbox/close", () => {
  const body = { id: ID, ifUpdatedAt: AT, decision: "resolve" };

  it("requires the paired phone's signature from the first request, with no terminal fallback", async () => {
    const unsigned = await call("/v1/owner-inbox/close", "POST", body);
    expect(unsigned.status).toBe(403);
    expect(unsigned.data).toMatchObject({ code: "owner-proof-required" });
    // `x-phren-owner-confirm: wait` cannot hold this one for the phone.
    const waiting = await call("/v1/owner-inbox/close", "POST", body, { "x-phren-owner-confirm": "wait" });
    expect(waiting.status).toBe(403);
    expect(confirmed).toBe(0);
    expect(inbox.close).not.toHaveBeenCalled();
  });

  it("refuses a peer gateway's origin and an agent's origin", async () => {
    const peer = await call("/v1/owner-inbox/close", "POST", body, { "x-phren-origin": "peer" });
    expect(peer.status).toBe(403);
    expect(peer.data.error).toContain("Only the owner's phone");
    const agent = await call("/v1/owner-inbox/close", "POST", { ...body, origin: { server: "default", workspace: "w", tab: "t", pane: "p" } });
    expect(agent.status).toBe(403);
    expect(inbox.close).not.toHaveBeenCalled();
  });

  it("refuses a stranger's proof and a replayed proof", async () => {
    const stranger = phone();
    const refused = await call("/v1/owner-inbox/close", "POST", body, { [OWNER_PROOF_HEADER]: proof(stranger, JSON.stringify(body)) });
    expect(refused.status).toBe(403);
    expect(refused.data).toMatchObject({ code: "owner-proof-invalid" });
    const header = proof(owner, JSON.stringify(body));
    expect((await call("/v1/owner-inbox/close", "POST", body, { [OWNER_PROOF_HEADER]: header })).status).toBe(200);
    const replay = await call("/v1/owner-inbox/close", "POST", body, { [OWNER_PROOF_HEADER]: header });
    expect(replay.status).toBe(403);
  });

  it("resolves and dismisses with the stored row and its owner", async () => {
    const raw = JSON.stringify(body);
    const resolved = await call("/v1/owner-inbox/close", "POST", body, { [OWNER_PROOF_HEADER]: proof(owner, raw) });
    expect(resolved.status).toBe(200);
    expect(resolved.data).toMatchObject({ ok: true, item: { id: ID, state: "resolved", resolution: "done", inboxComputer: "local" } });
    expect(inbox.close).toHaveBeenCalledWith(ID, AT, "resolve");

    const dismissed = await call("/v1/owner-inbox/close", "POST", { ...body, decision: "dismiss" },
      { [OWNER_PROOF_HEADER]: proof(owner, JSON.stringify({ ...body, decision: "dismiss" })) });
    expect(dismissed.status).toBe(200);
    expect(dismissed.data.item).toMatchObject({ resolution: "dismissed" });
    expect(inbox.close).toHaveBeenLastCalledWith(ID, AT, "dismiss");
  });

  it("passes the owned row's own 404 and 409 through the wire", async () => {
    inbox.close.mockRejectedValueOnce(new BridgeError(404, "No owner inbox item with that id.")).mockRejectedValueOnce(new BridgeError(409, "This inbox item changed."));
    const raw = JSON.stringify(body);
    const missing = await call("/v1/owner-inbox/close", "POST", body, { [OWNER_PROOF_HEADER]: proof(owner, raw) });
    expect(missing.status).toBe(404);
    const changed = await call("/v1/owner-inbox/close", "POST", body, { [OWNER_PROOF_HEADER]: proof(owner, raw) });
    expect(changed.status).toBe(409);
  });

  it("keeps the strict body free of extra keys", () => {
    expect(ownerInboxCloseSchema.parse({ id: ID, ifUpdatedAt: AT, decision: "dismiss" })).toEqual({ id: ID, ifUpdatedAt: AT, decision: "dismiss" });
    expect(() => ownerInboxCloseSchema.parse({ ...body, computer: "Desk" })).toThrow();
    expect(() => ownerInboxCloseSchema.parse({ ...body, decision: "undo" })).toThrow();
  });
});

describe("owner inbox capabilities and module gate", () => {
  it("advertises close and push wherever ownerInbox is enabled", () => {
    expect(capabilitiesForModules(snapshot as never)).toMatchObject({ ownerInbox: true, ownerInboxActions: true, ownerInboxClose: true, ownerInboxPush: true });
    const disabled = capabilitiesForModules({ ...snapshot, has: () => false, modules: [] } as never);
    expect(disabled.ownerInbox).toBeUndefined();
    expect(disabled.ownerInboxClose).toBeUndefined();
    expect(disabled.ownerInboxPush).toBeUndefined();
  });

  it("gates the close route on the conductor module", async () => {
    const handler = createRouteHandler({
      modules: { ...snapshot, has: () => false, modules: [] }, info: {}, inbox: inbox as unknown as OwnerInbox,
      streams: {}, agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set(), ownerConfirms: { confirm: async () => {} } },
      journal: { record: async () => {} }, tabActivity: { observe: async () => ({ generation: 0, stamps: new Map() }), recordStatus: async () => new Map() },
      contextUsage: { read: async () => new Map() },
    } as never);
    let body = "";
    const response = { statusCode: 200, setHeader() {}, end(value: string) { body = value; } };
    await handler({
      url: "/v1/owner-inbox/close", method: "POST", headers: {},
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ id: ID, ifUpdatedAt: AT, decision: "resolve" })); },
    } as unknown as IncomingMessage, response as unknown as ServerResponse);
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(body).error).toContain("conductor");
    expect(inbox.close).not.toHaveBeenCalled();
  });
});

describe("existing owner inbox routes", () => {
  it("keeps the legacy unsigned POST list and add", async () => {
    const added = await call("/v1/owner-inbox", "POST", { action: "add", title: "Restart the router", project: "phren" });
    expect(added.status).toBe(200);
    expect(added.data.ok).toBe(true);
    expect(inbox.run).toHaveBeenCalledWith({ action: "add", title: "Restart the router", project: "phren" });
  });

  it("answers a compact local read with only the phone's fields", async () => {
    const read = await call("/v1/owner-inbox?local=1&compact=1", "GET");
    expect(read.status).toBe(200);
    expect(read.data.items).toEqual([{ ...ROW }]);
  });

  it("answers a compact aggregate read from this Hook alone", async () => {
    const read = await call("/v1/owner-inbox?compact=1&includeResolved=true", "GET");
    expect(read.status).toBe(200);
    expect(read.data).toMatchObject({ ok: true, unreachable: [] });
    expect(read.data.items).toEqual([{ ...ROW, inboxComputer: "local" }]);
    // The local read still asks for history.
    expect(inbox.run).toHaveBeenCalledWith({ action: "list", includeResolved: true });
  });
});
