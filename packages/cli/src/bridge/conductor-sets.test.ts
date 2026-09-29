import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conductorAnswer, nameSet, readSets } from "./conductor-sets.js";
import { readSetName, resetRoleState } from "./conductor-role.js";
import { formatSets } from "./dispatch-command.js";
import { BridgeError, type Json } from "./protocol.js";

const mocks = vi.hoisted(() => ({ peers: [] as Json[], request: vi.fn() }));
vi.mock("./herdr.js", async importOriginal => ({ ...await importOriginal<typeof import("./herdr.js")>(), servers: async () => [] }));
vi.mock("./peers.js", async importOriginal => ({ ...await importOriginal<typeof import("./peers.js")>(),
  hookPeers: async () => mocks.peers, optionalHookPeers: async () => ({ peers: mocks.peers }), peerRequest: mocks.request }));

const hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPKDk8cewh74xDIccwQz/N4V05hPT+bdp5fEii+pzf9B";
const peer = (name: string) => ({ name, address: `${name.toLowerCase()}.example`, username: "sam", port: 22, server: "default", hostKey });
const info = { computer: { id: "30000000-0000-4000-8000-000000000002", name: "Omarchy" } };

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-conductor-sets-")); vi.stubEnv("PHREN_BRIDGE_HOME", root); resetRoleState(); mocks.request.mockReset(); });
afterEach(async () => { vi.unstubAllEnvs(); resetRoleState(); await rm(root, { recursive: true, force: true }); });

describe("GET /v1/conductor", () => {
  it("says whether this computer links the caller back only when asked", async () => {
    mocks.peers = [peer("Mini")];
    const asked = await conductorAnswer(info, new URL("http://phren.local/v1/conductor?name=mini.local"));
    expect(asked).toEqual({ computer: info.computer, conductor: null, peers: ["Mini"], knowsCaller: true });
    expect((await conductorAnswer(info, new URL("http://phren.local/v1/conductor?name=Laptop"))).knowsCaller).toBe(false);
    expect(await conductorAnswer(info, new URL("http://phren.local/v1/conductor"))).not.toHaveProperty("knowsCaller");
  });
});

describe("GET /v1/sets", () => {
  it("resolves a peer-reported local name by id through the existing phone identity contract", async () => {
    mocks.peers = [peer("Mini")];
    mocks.request.mockImplementation(async (_to: Json, route: string) => route === "/v1/computers"
      ? { computers: [{ id: info.computer.id, name: "Linuxbox", aliases: ["Omarchy"], local: false, linked: true }] }
      : { computer: { id: "30000000-0000-4000-8000-000000000001", name: "Mini" }, peers: ["Linuxbox"], knowsCaller: true });
    const view = await readSets(info);
    expect(view).toMatchObject({ sets: [{ local: true, computers: [
      { name: "Linuxbox", id: info.computer.id, local: true, reachable: true, link: "self" },
      { name: "Mini", link: "two-way" },
    ] }] });
    expect(formatSets(view)).toBe("Unnamed set (this computer)\n  Linuxbox: this computer\n  Mini: reachable, two-way link");
    expect(mocks.request.mock.calls.filter(call => call[1] === "/v1/computers")).toHaveLength(1);
  });

  it("keeps the old name-only view when a peer's identity directory is unavailable", async () => {
    mocks.peers = [peer("Mini")];
    mocks.request.mockImplementation(async (_to: Json, route: string) => {
      if (route === "/v1/computers") throw new BridgeError(404, "Unknown Phren Hook route.");
      return { computer: { name: "Mini" }, peers: ["Server"], knowsCaller: true };
    });
    expect(formatSets(await readSets(info))).toContain("Server: not asked, indirect link. Link it with phren bridge link Server.");
  });

  it("does not probe identity directories when every reported name is already known", async () => {
    mocks.peers = [peer("Mini")];
    mocks.request.mockResolvedValue({ computer: { name: "Mini" }, peers: ["Omarchy"], knowsCaller: true });
    await readSets(info);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});

describe("POST /v1/sets/name", () => {
  it("names the set here and on every reachable member, not on a one-way peer", async () => {
    mocks.peers = [peer("Mini"), peer("Laptop"), peer("Desk")];
    mocks.request.mockImplementation(async (to: Json, route: string) => {
      if (to.name === "Desk") throw new BridgeError(503, "The remote Hook is offline or SSH did not confirm the request.");
      if (route.startsWith("/v1/conductor")) return { computer: { name: to.name }, conductor: null, peers: [], knowsCaller: to.name === "Mini" };
      return { ok: true };
    });
    const result = await nameSet({ name: " Home " });
    expect(result).toMatchObject({ ok: true, name: "Home", told: ["Mini"], unreachable: [{ computer: "Desk" }] });
    expect(await readSetName()).toEqual({ name: "Home", namedAt: result.namedAt });
    const relays = mocks.request.mock.calls.filter(call => call[1] === "/v1/sets/name");
    expect(relays.map(call => [call[0].name, call[2]])).toEqual([["Mini", { name: "Home", namedAt: result.namedAt }]]);
  });

  it("keeps a member's relay only when newer, and sends it no further", async () => {
    await nameSet({ name: "Home", namedAt: "2026-09-29T10:00:00.000Z" });
    expect(await nameSet({ name: "Old", namedAt: "2026-09-29T09:00:00.000Z" })).toEqual({ ok: true, name: "Old", changed: false });
    expect(await readSetName()).toEqual({ name: "Home", namedAt: "2026-09-29T10:00:00.000Z" });
    expect(mocks.request).not.toHaveBeenCalled();
    await expect(nameSet({ name: "x".repeat(61) })).rejects.toThrow();
    await expect(nameSet({ name: "Bad\nname" })).rejects.toThrow();
  });
});

describe("phren conductor sets", () => {
  it("prints each set's computers with reachability, link and conductor, then unlinked computers", () => {
    expect(formatSets({
      sets: [{ name: "Home", local: true, conductors: 1, computers: [
        { name: "Omarchy", link: "self", reachable: true },
        { name: "Mini", link: "two-way", reachable: true, conductor: { server: "default" } },
        { name: "Desk", link: "unknown", reachable: false, error: "Offline." },
        { name: "Server", link: "indirect", hint: "Link it with phren bridge link Server." },
      ] }, { local: false, conductors: 0, computers: [{ name: "Laptop", link: "one-way", reachable: true, hint: "Laptop does not link back. Run phren bridge link Laptop." }] }],
      unlinked: [{ name: "alaarab.com" }],
    })).toBe([
      "Home (this computer)",
      "  Omarchy: this computer",
      "  Mini: reachable, two-way link, conductor",
      "  Desk: unreachable, unknown link. Offline.",
      "  Server: not asked, indirect link. Link it with phren bridge link Server.",
      "Unnamed set",
      "  Laptop: reachable, one-way link. Laptop does not link back. Run phren bridge link Laptop.",
      "Not linked",
      "  alaarab.com. Link it with phren bridge link alaarab.com.",
    ].join("\n"));
  });
});
