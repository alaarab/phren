import { describe, expect, it } from "vitest";
import { disabledHint } from "../modules/registry.js";
import { askPeers, buildSets, groupConductor, setConductor } from "./conductor-group.js";
import type { Computer } from "./computer-identity.js";
import type { HookPeer } from "./peers.js";
import { BridgeError, type Json } from "./protocol.js";

const peer = (name: string): HookPeer => ({ name, address: `${name.toLowerCase()}.example`, username: "sam", port: 22, server: "default",
  hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPKDk8cewh74xDIccwQz/N4V05hPT+bdp5fEii+pzf9B" });
const target = { server: "default", workspace: "w9", tab: "w9:t1", pane: "w9:p1", source: "claude" };
const caller = { name: "Omarchy", hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPKDk8cewh74xDIccwQz/N4V05hPT+bdp5fEii+pzf9B" };
const id = (n: number) => `30000000-0000-4000-8000-00000000000${n}`;

describe("one conductor per set", () => {
  it("finds a member's conductor and names the members it could not rule out", async () => {
    const answers: Record<string, () => Json> = {
      Mini: () => ({ computer: { id: id(1), name: "Mini" }, conductor: null, peers: ["Omarchy", "MacBook"], knowsCaller: true }),
      MacBook: () => ({ computer: { id: id(2), name: "MacBook" }, conductor: { server: "default", target }, peers: ["Omarchy", "Mini"], knowsCaller: true }),
      Linuxbox: () => { throw new BridgeError(503, "The remote Hook is offline or SSH did not confirm the request.", { code: "peer-offline" }); },
      Laptop: () => { throw new BridgeError(404, "Unknown Phren Hook route."); },
      Desk: () => { throw new BridgeError(404, disabledHint("conductor")); },
    };
    const asked: string[] = [];
    const result = await groupConductor(Object.keys(answers).map(peer), ["Omarchy"], async (to, route) => { asked.push(`${to.name} ${route}`); return answers[to.name](); }, caller);
    // Each peer is told who asks, so it can say whether it links back.
    expect(asked.sort()).toEqual(Object.keys(answers).map(name => `${name} /v1/conductor?${new URLSearchParams(caller)}`).sort());
    expect(result).toEqual({
      found: { computer: "MacBook", target },
      // A disabled conductor module means no conductor can run there; an older Hook cannot say.
      unchecked: [
        { computer: "Linuxbox", error: "The remote Hook is offline or SSH did not confirm the request.", code: "peer-offline" },
        { computer: "Laptop", error: "Its Hook is too old to report a conductor." },
      ],
    });
  });

  it("lets a computer outside the set keep its own conductor, and names members this computer cannot ask", async () => {
    const answers = await askPeers([peer("Mini"), peer("Server")], caller, async to => to.name === "Server"
      // Server lists nobody back: it is its own set, and its conductor is not this set's.
      ? { computer: { id: id(3), name: "server" }, conductor: { server: "default", target }, peers: [], knowsCaller: false }
      : { computer: { id: id(1), name: "Mini", aliases: ["mini.local"] }, conductor: null, peers: ["Omarchy", "Desk.local", "server"], knowsCaller: true });
    expect(setConductor(answers, ["Omarchy"])).toEqual({ unchecked: [
      { computer: "Desk.local", error: "Not linked with this computer, so it could not be asked. Link it with phren bridge link Desk.local." },
    ] });
  });

  it("treats a Hook too old to say whether it links back as a member, as before sets", async () => {
    const answers = await askPeers([peer("Mini")], caller, async () => ({ computer: { id: id(1), name: "Mini" }, conductor: { server: "default", target } }));
    expect(setConductor(answers, ["Omarchy"]).found).toEqual({ computer: "Mini", target });
  });
});

describe("the sets view", () => {
  const unlinked: Computer = { name: "alaarab.com", aliases: [], profile: "server", local: false, linked: false };
  const linkedRow: Computer = { name: "Mini", aliases: [], local: false, linked: true };

  it("lists this computer's set with reachability, links and its conductor, then one-way peers' sets and unlinked computers", async () => {
    const answers = await askPeers(["Mini", "Laptop", "Desk", "Old"].map(peer), caller, async to => {
      if (to.name === "Mini") return { computer: { id: id(1), name: "Mini" }, conductor: { server: "default", target }, peers: ["Omarchy", "Server"], knowsCaller: true,
        set: { name: "Home", namedAt: "2026-09-29T10:00:00.000Z" } };
      if (to.name === "Laptop") return { computer: { id: id(4), name: "Laptop" }, conductor: null, peers: [], knowsCaller: false };
      if (to.name === "Old") return { computer: { id: id(5), name: "Old" }, conductor: null };
      throw new BridgeError(503, "The remote Hook is offline or SSH did not confirm the request.", { code: "peer-offline" });
    });
    const view = buildSets({ local: { name: "Omarchy", id: id(2), set: { name: "House", namedAt: "2026-09-29T09:00:00.000Z" }, names: ["Omarchy"] },
      answers, computers: [linkedRow, unlinked, { name: "server", aliases: [], local: false, linked: false }] });
    expect(view.sets).toEqual([{
      id: `set:${id(1)}`, name: "Home", namedAt: "2026-09-29T10:00:00.000Z", local: true,
      computers: [
        { name: "Omarchy", id: id(2), local: true, reachable: true, link: "self" },
        { name: "Mini", id: id(1), reachable: true, link: "two-way", conductor: { server: "default", target } },
        { name: "Desk", reachable: false, link: "unknown", error: "The remote Hook is offline or SSH did not confirm the request.", code: "peer-offline" },
        { name: "Old", id: id(5), reachable: true, link: "unknown", hint: "Its Hook cannot say whether it links back. Update it with phren bridge update." },
        { name: "Server", link: "indirect", hint: "Link it with phren bridge link Server." },
      ],
      conductor: { computer: "Mini", target }, conductors: 1,
    }, {
      id: `set:${id(4)}`, local: false,
      computers: [{ name: "Laptop", id: id(4), reachable: true, link: "one-way", hint: "Laptop does not link back. Run phren bridge link Laptop." }],
      conductors: 0,
    }]);
    // "server" is already listed as an indirect member.
    expect(view.unlinked).toEqual([unlinked]);
  });

  it("shows two conductors in one set, from before the computers were linked", async () => {
    const answers = await askPeers([peer("Mini")], caller, async () => ({ computer: { id: id(1), name: "Mini" }, conductor: { server: "default", target }, peers: ["Omarchy"], knowsCaller: true }));
    const local = { server: "tmux", target: { ...target, server: "tmux", pane: "p1" } };
    const [set] = buildSets({ local: { name: "Omarchy", id: id(2), conductor: local, names: ["Omarchy"] }, answers, computers: [] }).sets;
    expect(set).toMatchObject({ conductor: { computer: "Omarchy", target: local.target }, conductors: 2 });
    expect(set.name).toBeUndefined();
  });
});
