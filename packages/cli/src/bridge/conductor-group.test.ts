import { expect, it } from "vitest";
import { disabledHint } from "../modules/registry.js";
import { groupConductor } from "./conductor-group.js";
import type { HookPeer } from "./peers.js";
import { BridgeError, type Json } from "./protocol.js";

const peer = (name: string): HookPeer => ({ name, address: `${name.toLowerCase()}.example`, username: "sam", port: 22, server: "default",
  hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPKDk8cewh74xDIccwQz/N4V05hPT+bdp5fEii+pzf9B" });
const target = { server: "default", workspace: "w9", tab: "w9:t1", pane: "w9:p1", source: "claude" };

it("finds a linked peer's conductor and names the peers it could not rule out", async () => {
  const answers: Record<string, () => Json> = {
    Mini: () => ({ conductor: null }),
    MacBook: () => ({ conductor: { server: "default", target } }),
    Linuxbox: () => { throw new BridgeError(503, "The remote Hook is offline or SSH did not confirm the request.", { code: "peer-offline" }); },
    Laptop: () => { throw new BridgeError(404, "Unknown Phren Hook route."); },
    Desk: () => { throw new BridgeError(404, disabledHint("conductor")); },
  };
  const asked: string[] = [];
  const result = await groupConductor(Object.keys(answers).map(peer), async (to, route) => { asked.push(`${to.name} ${route}`); return answers[to.name](); });
  expect(asked.sort()).toEqual(Object.keys(answers).map(name => `${name} /v1/conductor`).sort());
  expect(result).toEqual({
    found: { computer: "MacBook", target },
    // A disabled conductor module means no conductor can run there; an older Hook cannot say.
    unchecked: [
      { computer: "Linuxbox", error: "The remote Hook is offline or SSH did not confirm the request.", code: "peer-offline" },
      { computer: "Laptop", error: "Its Hook is too old to report a conductor." },
    ],
  });
});
