import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Json } from "./protocol.js";
import { bodyDigest, OWNER_PROOF_HEADER } from "./owner-proof.js";
import { OwnerInbox } from "./owner-inbox.js";
import { createRouteHandler, capabilitiesForModules } from "./server-routes.js";

const state = vi.hoisted(() => ({ home: "" }));
vi.mock("../home-paths.js", async original => ({
  ...(await original<typeof import("../home-paths.js")>()), homeDir: () => state.home,
}));

const AT = "2026-11-27T10:00:00.000Z";
const ID = "aaaaaaaa-1111-4111-8111-111111111111";
const UPPER = "AAAAAAAA-1111-4111-8111-111111111111";
const TITLE = "OVH US VPS-2 is in stock";

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

let root: string, owner: Phone, inbox: OwnerInbox;
let confirmed = 0;

async function call(pathname: string, method: string, payload?: unknown, headers: Record<string, string> = {}) {
  const handler = createRouteHandler({
    modules: snapshot, info: { computer: { id: "computer-1", name: "Test" } }, inbox,
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

/** A signed close of one exact body, as the phone sends it. */
function close(payload: Json) {
  return call("/v1/owner-inbox/close", "POST", payload, { [OWNER_PROOF_HEADER]: proof(owner, JSON.stringify(payload)) });
}

/** Add a real persisted row and hand back its stored revision. */
async function add(fields: Json): Promise<{ id: string; updatedAt: string; title: string }> {
  const result = await inbox.run({ action: "add", ...fields });
  return result.item as { id: string; updatedAt: string; title: string };
}
const stored = async () => (await inbox.run({ action: "list", includeResolved: true })).items as Json[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "owner-inbox-close-"));
  state.home = path.join(root, "home");
  process.env.PHREN_BRIDGE_HOME = path.join(root, "bridge");
  owner = phone();
  await mkdir(path.join(state.home, ".ssh"), { recursive: true });
  await writeFile(path.join(state.home, ".ssh", "authorized_keys"), owner.authorizedKeys);
  confirmed = 0;
  inbox = new OwnerInbox(async () => [], path.join(root, "owner-inbox.json"));
});
afterEach(async () => {
  delete process.env.PHREN_BRIDGE_HOME;
  await rm(root, { recursive: true, force: true });
});

describe("POST /v1/owner-inbox/close", () => {
  it("requires the paired phone's signature from the first request, with no terminal fallback", async () => {
    const row = await add({ id: ID, title: TITLE });
    const body = { id: row.id, ifUpdatedAt: row.updatedAt, decision: "resolve" };
    const unsigned = await call("/v1/owner-inbox/close", "POST", body);
    expect(unsigned.status).toBe(403);
    expect(unsigned.data).toMatchObject({ code: "owner-proof-required" });
    // `x-phren-owner-confirm: wait` cannot hold this one for the phone.
    const waiting = await call("/v1/owner-inbox/close", "POST", body, { "x-phren-owner-confirm": "wait" });
    expect(waiting.status).toBe(403);
    expect(confirmed).toBe(0);
    expect((await stored())[0]).toMatchObject({ state: "open" });
  });

  it("refuses a peer gateway's origin and an agent's origin", async () => {
    const row = await add({ id: ID, title: TITLE });
    const body = { id: row.id, ifUpdatedAt: row.updatedAt, decision: "resolve" };
    const peer = await call("/v1/owner-inbox/close", "POST", body, { "x-phren-origin": "peer" });
    expect(peer.status).toBe(403);
    expect(peer.data.error).toContain("Only the owner's phone");
    const agent = await call("/v1/owner-inbox/close", "POST", { ...body, origin: { server: "default", workspace: "w", tab: "t", pane: "p" } });
    expect(agent.status).toBe(403);
    expect((await stored())[0]).toMatchObject({ state: "open" });
  });

  it("refuses a stranger's proof and a replayed proof", async () => {
    const row = await add({ id: ID, title: TITLE });
    const body = { id: row.id, ifUpdatedAt: row.updatedAt, decision: "resolve" };
    const stranger = phone();
    const refused = await call("/v1/owner-inbox/close", "POST", body, { [OWNER_PROOF_HEADER]: proof(stranger, JSON.stringify(body)) });
    expect(refused.status).toBe(403);
    expect(refused.data).toMatchObject({ code: "owner-proof-invalid" });
    const header = proof(owner, JSON.stringify(body));
    expect((await call("/v1/owner-inbox/close", "POST", body, { [OWNER_PROOF_HEADER]: header })).status).toBe(200);
    const replay = await call("/v1/owner-inbox/close", "POST", body, { [OWNER_PROOF_HEADER]: header });
    expect(replay.status).toBe(403);
  });

  it("resolves and dismisses a real persisted row with its owner", async () => {
    const row = await add({ id: ID, title: TITLE, project: "phren" });
    const resolved = await close({ id: row.id, ifUpdatedAt: row.updatedAt, decision: "resolve" });
    expect(resolved.status).toBe(200);
    expect(resolved.data).toMatchObject({ ok: true, item: { id: ID, state: "resolved", resolution: "done", inboxComputer: "local" } });
    expect((await stored())[0]).toMatchObject({ state: "resolved", resolution: "done", resolvedAt: expect.any(String) });
    expect((await stored())[0].updatedAt).not.toBe(row.updatedAt);

    const second = await add({ id: "bbbbbbbb-2222-4222-8222-222222222222", title: "Dismiss me" });
    const dismissed = await close({ id: second.id, ifUpdatedAt: second.updatedAt, decision: "dismiss" });
    expect(dismissed.status).toBe(200);
    expect(dismissed.data.item).toMatchObject({ resolution: "dismissed" });
  });

  it("finds a legacy uppercase UUID case-insensitively and keeps the exact revision check", async () => {
    const row = await add({ id: UPPER, title: TITLE });
    expect(row.id).toBe(UPPER);
    const stale = await close({ id: ID, ifUpdatedAt: AT, decision: "resolve" });
    expect(stale.status).toBe(409);
    expect(stale.data.error).toContain("changed");
    const closed = await close({ id: ID, ifUpdatedAt: row.updatedAt, decision: "resolve" });
    expect(closed.status).toBe(200);
    expect(closed.data.item).toMatchObject({ id: UPPER, resolution: "done" });
  });

  it("refuses an ambiguous legacy case collision with 409", async () => {
    await add({ id: UPPER, title: "Uppercase copy" });
    const lower = await add({ id: ID, title: "Lowercase copy" });
    const refused = await close({ id: ID, ifUpdatedAt: lower.updatedAt, decision: "dismiss" });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toContain("More than one");
    expect((await stored()).every(row => row.state === "open")).toBe(true);
  });

  it("refuses an already handled row with 409", async () => {
    const row = await add({ id: ID, title: TITLE });
    expect((await close({ id: row.id, ifUpdatedAt: row.updatedAt, decision: "resolve" })).status).toBe(200);
    const again = await close({ id: row.id, ifUpdatedAt: row.updatedAt, decision: "dismiss" });
    expect(again.status).toBe(409);
    expect(again.data.error).toContain("already handled");
  });

  it("rejects a signed malformed body at the route with 400", async () => {
    const row = await add({ id: ID, title: TITLE });
    const bad = await close({ id: row.id, ifUpdatedAt: row.updatedAt, decision: "undo" });
    expect(bad.status).toBe(400);
    const extra = await close({ id: row.id, ifUpdatedAt: row.updatedAt, decision: "resolve", computer: "Desk" });
    expect(extra.status).toBe(400);
    const missing = await close({ id: row.id, decision: "resolve" });
    expect(missing.status).toBe(400);
    // None of them touched the row.
    expect((await stored())[0]).toMatchObject({ state: "open" });
  });

  it("passes the owned row's 404 through the signed route", async () => {
    const missing = await close({ id: randomUUID(), ifUpdatedAt: AT, decision: "resolve" });
    expect(missing.status).toBe(404);
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
    const row = await add({ id: ID, title: TITLE });
    const handler = createRouteHandler({
      modules: { ...snapshot, has: () => false, modules: [] }, info: {}, inbox,
      streams: {}, agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set(), ownerConfirms: { confirm: async () => {} } },
      journal: { record: async () => {} }, tabActivity: { observe: async () => ({ generation: 0, stamps: new Map() }), recordStatus: async () => new Map() },
      contextUsage: { read: async () => new Map() },
    } as never);
    let body = "";
    const response = { statusCode: 200, setHeader() {}, end(value: string) { body = value; } };
    await handler({
      url: "/v1/owner-inbox/close", method: "POST", headers: {},
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ id: row.id, ifUpdatedAt: row.updatedAt, decision: "resolve" })); },
    } as unknown as IncomingMessage, response as unknown as ServerResponse);
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(body).error).toContain("conductor");
    expect((await stored())[0]).toMatchObject({ state: "open" });
  });
});

describe("existing owner inbox routes", () => {
  it("keeps the legacy unsigned POST add and the GET read", async () => {
    const added = await call("/v1/owner-inbox", "POST", { action: "add", id: ID, title: "Restart the router", project: "phren" });
    expect(added.status).toBe(200);
    expect(added.data.item).toMatchObject({ id: ID, state: "open", title: "Restart the router" });
    const read = await call("/v1/owner-inbox?local=1", "GET");
    expect(read.status).toBe(200);
    expect(read.data.items).toEqual([expect.objectContaining({ id: ID, state: "open", title: "Restart the router" })]);
  });

  it("answers a compact local read with only the phone's fields", async () => {
    await add({ id: ID, title: TITLE });
    const read = await call("/v1/owner-inbox?local=1&compact=1", "GET");
    expect(read.status).toBe(200);
    expect(read.data.items).toEqual([{ id: ID, title: TITLE, kind: "manual", state: "open", createdAt: expect.any(String), updatedAt: expect.any(String) }]);
  });

  it("keeps the aggregation keys for a peer read that asks and strips them when it does not", async () => {
    inbox = new OwnerInbox(async () => [{ source: "task-stale:phren:bid:c2cc33d0", kind: "blocked", title: "Claim the stale task" }], path.join(root, "owner-inbox.json"));
    await inbox.run({ action: "list" });
    const peer = await call("/v1/owner-inbox?local=1&compact=1&reconcile=1", "GET");
    expect(peer.data.items).toEqual([expect.objectContaining({ kind: "blocked", live: true, source: "task-stale:phren:bid:c2cc33d0" })]);
    const plain = await call("/v1/owner-inbox?local=1&compact=1", "GET");
    expect(plain.data.items[0]).not.toHaveProperty("live");
    expect(plain.data.items[0]).not.toHaveProperty("source");
    // `reconcile` is mine to read only on a local read; an aggregate read ignores it.
    const aggregate = await call("/v1/owner-inbox?compact=1&reconcile=1", "GET");
    expect(aggregate.data.items[0]).not.toHaveProperty("live");
  });

  it("answers a compact aggregate read from this Hook alone", async () => {
    await add({ id: ID, title: TITLE });
    const read = await call("/v1/owner-inbox?compact=1&includeResolved=true", "GET");
    expect(read.status).toBe(200);
    expect(read.data).toMatchObject({ ok: true, unreachable: [] });
    expect(read.data.items).toHaveLength(1);
    expect(read.data.items[0]).toMatchObject({ id: ID, inboxComputer: "local" });
    expect(read.data.items[0]).not.toHaveProperty("live");
  });
});
