import { describe, expect, it } from "vitest";
import { foldComputers, resolveComputer, type IdentityFacts } from "./computer-identity.js";

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
