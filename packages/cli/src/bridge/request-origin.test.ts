import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { ownerRequest, requestPeer } from "./request-origin.js";

const request = (headers: Record<string, string | string[]> = {}) => ({ headers } as Pick<IncomingMessage, "headers">);
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fingerprint = "a".repeat(64);
const id = "12345678-1234-1234-1234-123456789abc";
const peer = (value: unknown) => requestPeer(request({ "x-phren-origin": "peer", "x-phren-peer": encoded(value) }));

describe("owner requests", () => {
  it("are owner requests only with neither an origin header nor a body origin", () => {
    expect(ownerRequest(request(), {})).toBe(true);
    expect(ownerRequest(request({ "x-phren-origin": "peer" }), {})).toBe(false);
    expect(ownerRequest(request({ "x-phren-origin": "mcp" }), { origin: "claude" })).toBe(false);
    expect(ownerRequest(request({ "x-phren-origin": "" }), {})).toBe(false);
    // An explicit null origin still names a caller, so it is not the owner.
    expect(ownerRequest(request(), { origin: null })).toBe(false);
  });
});

describe("peer requests", () => {
  it("are absent unless a peer gateway marked them and supplied a single encoded header", () => {
    expect(requestPeer(request())).toBeUndefined();
    expect(requestPeer(request({ "x-phren-origin": "owner" }))).toBeUndefined();
    expect(requestPeer(request({ "x-phren-origin": "peer" }))).toBeUndefined();
    expect(requestPeer(request({ "x-phren-origin": "peer", "x-phren-peer": ["encoded"] }))).toBeUndefined();
    expect(requestPeer(request({ "x-phren-origin": "peer", "x-phren-peer": encoded("not an object") }))).toBeUndefined();
    expect(requestPeer(request({ "x-phren-origin": "peer", "x-phren-peer": Buffer.from("{oops").toString("base64url") }))).toBeUndefined();
  });

  it("decodes to only the name, id and fingerprint the payload carries", () => {
    expect(peer({ name: "Desk", id, fingerprint, extra: "ignored" })).toEqual({ name: "Desk", id, fingerprint });
    expect(peer({ fingerprint })).toBeUndefined();
    expect(peer({ name: "Desk", fingerprint })).toEqual({ name: "Desk", fingerprint });
    expect(peer({ id: id.toUpperCase(), fingerprint })).toEqual({ id: id.toUpperCase(), fingerprint });
  });

  it.each([
    ["a short fingerprint", { name: "Desk", fingerprint: "a".repeat(63) }],
    ["an uppercase fingerprint", { name: "Desk", fingerprint: "A".repeat(64) }],
    ["a malformed id", { name: "Desk", id: "not-a-uuid", fingerprint }],
    ["a name with a slash", { name: "Desk/One", fingerprint }],
    ["an empty name", { name: "", fingerprint }],
    ["a numeric name", { name: 42, fingerprint }],
  ])("rejects %s", (_label, payload) => {
    expect(peer(payload)).toBeUndefined();
  });

  it("rejects a fingerprint or id that is not a string", () => {
    expect(peer({ name: "Desk", fingerprint: [fingerprint] })).toBeUndefined();
    expect(peer({ name: "Desk", id: [id], fingerprint })).toBeUndefined();
    expect(peer({ name: "Desk", fingerprint: { toString: () => fingerprint } })).toBeUndefined();
  });
});
