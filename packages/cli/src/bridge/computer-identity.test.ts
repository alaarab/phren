import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { foldComputers, readComputers, resolveComputer, type IdentityFacts } from "./computer-identity.js";
import { addGrant, matchGrant } from "./grants.js";

// A verified peer whose Hook claims the MacBook's names.
vi.mock("./peers.js", () => ({
  optionalHookPeers: async () => ({ peers: [
    { name: "Aardvark", address: "aardvark.lan", username: "x", port: 22, server: "default" },
    { name: "MacBook", address: "alas-macbook-pro", username: "x", port: 22, server: "default" },
  ] }),
  peerRequest: async (peer: { name: string }) => peer.name === "Aardvark"
    ? { computer: { id: "aard-id", name: "Aardvark", aliases: ["MacBook", "Alas-MacBook-Pro.local", "Mac"] } }
    : { computer: { id: "book-id", name: "Alas-MacBook-Pro.local", aliases: [] } },
}));

// The owner's setup: one Mac mini (this computer), a MacBook and an Omarchy box
// linked over SSH, and three computers registered but never linked.
const owner: IdentityFacts = {
  local: { id: "mini-id", names: ["Mac.attlocal.net", "Mac", "Squids-Mac-mini"] },
  peers: [
    { name: "MacBook", address: "alas-macbook-pro", id: "book-id", names: ["Alas-MacBook-Pro.local"], reachable: true },
    { name: "Linuxbox", address: "omarchy", id: "arch-id", names: [], reachable: false },
  ],
  machines: {
    Mac: "mac-mini", "Mac.attlocal.net": "mac-mini", "Squids-Mac-mini.local": "mac-mini",
    MacBookPro: "macbook", "MacBookPro.attlocal.net": "macbook", "Alas-MacBook-Pro.local": "macbook",
    omarchy: "omarchy", pj: "personal", "QL-PF5A48WS": "ql-laptop", "QL-PF6D9EGK": "work",
  },
};

describe("foldComputers", () => {
  it("folds the owner's names into one row per computer", () => {
    expect(foldComputers(owner)).toEqual([
      { id: "mini-id", name: "Mac", aliases: ["Mac.attlocal.net", "Squids-Mac-mini", "Squids-Mac-mini.local"], profile: "mac-mini", local: true, linked: true, reachable: true },
      { id: "arch-id", name: "Linuxbox", aliases: ["omarchy"], profile: "omarchy", local: false, linked: true, reachable: false },
      { id: "book-id", name: "MacBook", aliases: ["alas-macbook-pro", "Alas-MacBook-Pro.local", "MacBookPro", "MacBookPro.attlocal.net"], profile: "macbook", local: false, linked: true, reachable: true },
      { name: "pj", aliases: [], profile: "personal", local: false, linked: false },
      { name: "QL-PF5A48WS", aliases: [], profile: "ql-laptop", local: false, linked: false },
      { name: "QL-PF6D9EGK", aliases: [], profile: "work", local: false, linked: false },
    ]);
  });

  it("does not fold by a profile two computers claim", () => {
    const rows = foldComputers({
      local: { names: ["Desk"] }, peers: [{ name: "Linuxbox", address: "linuxbox.example" }],
      machines: { Desk: "home", Linuxbox: "home", Stranger: "home" },
    });
    expect(rows.map(row => [row.name, row.linked])).toEqual([["Desk", true], ["Linuxbox", true], ["Stranger", false]]);
    expect(rows[0].aliases).toEqual([]);
  });

  it("groups unlinked names by label, then by profile, shortest name leading", () => {
    const rows = foldComputers({ local: { names: ["Desk"] }, peers: [], machines: {
      "Box.example.net": "lab", box: "lab", "box.local": "lab", "Other.lan": "lab", Elsewhere: "x" } });
    expect(rows.filter(row => !row.linked)).toEqual([
      { name: "box", aliases: ["Box.example.net", "Other.lan", "box.local"].sort((a, b) => a.length - b.length || a.localeCompare(b)), profile: "lab", local: false, linked: false },
      { name: "Elsewhere", aliases: [], profile: "x", local: false, linked: false },
    ]);
  });

  it("keeps an IPv4 peer address whole and tolerates no machines", () => {
    const rows = foldComputers({ local: { names: [] }, peers: [{ name: "Pi", address: "10.0.0.8" }, { name: "Pi2", address: "10.0.0.9" }], machines: { "10.0.0.8": "pi" } });
    expect(rows.map(row => [row.name, row.aliases, row.profile])).toEqual([["local", [], undefined], ["Pi", ["10.0.0.8"], "pi"], ["Pi2", ["10.0.0.9"], undefined]]);
  });
});

describe("resolveComputer", () => {
  const computers = foldComputers(owner);
  it("finds a computer by name or any alias, ignoring case and domain", () => {
    for (const name of ["Mac", "mac.attlocal.net", "Squids-Mac-mini.local", "SQUIDS-MAC-MINI", "local", "localhost"]) expect(resolveComputer(computers, name)?.name).toBe("Mac");
    for (const name of ["MacBook", "macbookpro.attlocal.net", "alas-macbook-pro.tailnet.ts.net"]) expect(resolveComputer(computers, name)?.name).toBe("MacBook");
    expect(resolveComputer(computers, "omarchy")?.name).toBe("Linuxbox");
    expect(resolveComputer(computers, "pj")).toMatchObject({ linked: false });
  });
  it("returns nothing for an unknown or empty name", () => {
    expect(resolveComputer(computers, "Nowhere")).toBeUndefined();
    expect(resolveComputer(computers, " ")).toBeUndefined();
  });
});

describe("names a peer reports about itself", () => {
  const facts: IdentityFacts = {
    local: { names: ["Mac.attlocal.net", "Mac"] },
    peers: [
      { name: "Aardvark", address: "aardvark.lan", names: ["MacBook", "alas-macbook-pro.tailnet", "Mac.evil", "Burrow"] },
      { name: "MacBook", address: "alas-macbook-pro" },
    ],
    machines: {},
  };

  it("never take a name or label another computer already has", () => {
    const rows = foldComputers(facts);
    expect(rows.find(row => row.name === "Aardvark")?.aliases).toEqual(["aardvark.lan", "Burrow"]);
    expect(resolveComputer(rows, "MacBook")?.name).toBe("MacBook");
    expect(resolveComputer(rows, "Mac")?.name).toBe("Mac");
  });

  it("are left out of the trusted rows grants match against", () => {
    const rows = foldComputers(facts, { trusted: true });
    expect(rows.find(row => row.name === "Aardvark")?.aliases).toEqual(["aardvark.lan"]);
    const macbookOnly = { scope: "global" as const, actions: ["dispatch" as const], computers: ["MacBook"] };
    expect(matchGrant([macbookOnly], { action: "dispatch", computer: "Aardvark", computers: rows })).toBeUndefined();
    expect(matchGrant([macbookOnly], { action: "dispatch", computer: "Burrow", computers: foldComputers(facts) })).toBeUndefined();
    expect(matchGrant([macbookOnly], { action: "dispatch", computer: "MacBook", computers: rows })).toBe(macbookOnly);
  });

  it("resolve an ambiguous first label to nothing", () => {
    const rows = foldComputers({ local: { names: ["Desk"] }, peers: [{ name: "Box", address: "box.lan" }, { name: "Box2", address: "box.example" }], machines: {} });
    expect(resolveComputer(rows, "box.other")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("do not steer addGrant's canonical names, even after a probe", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "phren-identity-"));
    try {
      const probed = await readComputers({ probe: true, store: null, local: { names: ["Mac"] }, root });
      expect(probed.computers.find(row => row.name === "Aardvark")?.aliases).not.toContain("MacBook");
      const trusted = await readComputers({ trusted: true, store: null, local: { names: ["Mac"] }, root });
      expect(trusted.computers.find(row => row.name === "MacBook")?.aliases).toEqual(["alas-macbook-pro"]);
      // Canonicalised through trusted rows only: the self-reported alias is not resolved to Aardvark.
      const added = await addGrant({ scope: "global", actions: ["dispatch"], computers: ["Alas-MacBook-Pro.local"] }, root);
      expect(added.computers).toEqual(["MacBook"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
