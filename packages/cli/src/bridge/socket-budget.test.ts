import { describe, expect, it } from "vitest";
import { SocketBudget, socketIdentity, socketKind } from "./socket-budget.js";

const peerHeader = (fingerprint: string) => Buffer.from(JSON.stringify({ name: "mini", fingerprint })).toString("base64url");
const fill = (budget: SocketBudget<string>, identity: string, kind: string, n: number, tag = identity + kind) => {
  const evicted: string[] = [];
  for (let i = 0; i < n; i++) evicted.push(...budget.add(`${tag}${i}`, identity, kind));
  return evicted;
};

describe("socket identity", () => {
  it("is the owner unless the gateway set a valid peer origin", () => {
    expect(socketIdentity({ headers: {} })).toBe("owner");
    expect(socketIdentity({ headers: { "x-phren-client": "desktop" } })).toBe("owner");
    expect(socketIdentity({ headers: { "x-phren-origin": "peer", "x-phren-peer": "garbage" } })).toBe("owner");
    expect(socketIdentity({ headers: { "x-phren-origin": "peer", "x-phren-peer": peerHeader("a".repeat(64)) } })).toBe(`peer:${"a".repeat(64)}`);
  });
  it("keeps the client header as a sub-pool hint only", () => {
    expect(socketKind({ headers: { "x-phren-client": "desktop" } })).toBe("desktop");
    expect(socketKind({ headers: { "x-phren-client": "anything" } })).toBe("default");
  });
});

describe("socket budget", () => {
  it("lets the owner's local, phone and desktop sockets all connect", () => {
    const budget = new SocketBudget<string>();
    expect(fill(budget, "owner", "default", 16, "phone")).toEqual([]);
    expect(fill(budget, "owner", "desktop", 12, "desktop")).toEqual([]);
    expect(budget.count("owner")).toBe(28);
  });
  it("gives two identities their own budgets", () => {
    const budget = new SocketBudget<string>();
    fill(budget, "owner", "default", 16); fill(budget, "owner", "desktop", 16);
    expect(fill(budget, "peer:b", "default", 16)).toEqual([]);
    expect(budget.count("owner")).toBe(32);
    expect(budget.count("peer:b")).toBe(16);
    // The owner filling up again never evicts the peer's sockets.
    const evicted = fill(budget, "owner", "default", 5, "more");
    expect(evicted.every(socket => !socket.startsWith("peer"))).toBe(true);
    expect(budget.count("peer:b")).toBe(16);
  });
  it("holds a spoofed client header to the identity's total", () => {
    const budget = new SocketBudget<string>();
    for (let i = 0; i < 100; i++) budget.add(`s${i}`, "owner", `kind-${i % 7}`);
    expect(budget.count("owner")).toBeLessThanOrEqual(32);
    fill(budget, "owner", "default", 40, "x");
    expect(budget.count("owner")).toBeLessThanOrEqual(32);
  });
  it("evicts the oldest socket of an identity first", () => {
    const budget = new SocketBudget<string>();
    fill(budget, "owner", "default", 16, "a");
    expect(budget.add("new", "owner", "default")).toEqual(["a0"]);
  });
  it("trims the heaviest identity when the global cap is hit and forgets closed sockets", () => {
    const budget = new SocketBudget<string>({ kind: 16, identity: 32, total: 40 });
    fill(budget, "owner", "default", 16); fill(budget, "owner", "desktop", 16);
    fill(budget, "p1", "default", 5); fill(budget, "p2", "default", 3);
    expect(budget.add("p3", "p3", "default")).toEqual(["ownerdefault0"]);
    expect(budget.count()).toBe(40);
    budget.remove("p3");
    expect(budget.count()).toBe(39);
  });
  it("evicts a peer identity before the owner when they tie at the global cap", () => {
    const budget = new SocketBudget<string>({ kind: 16, identity: 32, total: 31 });
    fill(budget, "owner", "default", 15);
    fill(budget, "p1", "default", 16);
    expect(budget.add("owner-new", "owner", "desktop")).toEqual(["p1default0"]);
  });
});
