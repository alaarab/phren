import { describe, expect, it } from "vitest";
// @ts-expect-error Plain ESM UI module, exercised without a DOM.
import { peerChip, peerChips } from "../ui/sections/settings/peer-chips.js";

describe("peerChip", () => {
  it("labels a reachable peer with its latency", () => {
    expect(peerChip({ name: "Studio", reachable: true, ms: 42.4, version: "0.3.53", listsBack: true }, "0.3.53"))
      .toMatchObject({ label: "Studio · 42 ms", level: "ok" });
  });

  it("labels an unreachable peer and carries the last error in the tooltip", () => {
    expect(peerChip({ name: "Laptop", reachable: false, ms: 5000, error: "No answer within 5 seconds." }, "0.3.53"))
      .toEqual({ label: "Laptop · unreachable", level: "fail", title: "No answer within 5 seconds." });
    expect(peerChip({ name: "Laptop", reachable: false }, "0.3.53").title).toMatch(/No error was reported/);
  });

  it("says an older peer Hook can be updated, and ignores a newer or unknown one", () => {
    expect(peerChip({ name: "Mini", reachable: true, ms: 9, version: "0.3.40" }, "0.3.53"))
      .toMatchObject({ label: "Mini · Hook 0.3.40 (update available)", level: "warn" });
    expect(peerChip({ name: "Mini", reachable: true, ms: 9, version: "0.4.0" }, "0.3.53").label).toBe("Mini · 9 ms");
    expect(peerChip({ name: "Mini", reachable: true, ms: 9, version: "0.3.40" }, undefined).label).toBe("Mini · 9 ms");
  });

  it("warns when the peer does not list this computer back", () => {
    expect(peerChip({ name: "NAS", reachable: true, ms: 12, listsBack: false }, "0.3.53"))
      .toMatchObject({ level: "warn", title: "NAS does not list this computer back." });
  });

  it("copes with missing fields", () => {
    expect(peerChip({ reachable: true }, "0.3.53")).toMatchObject({ label: "Unnamed · reachable", level: "ok" });
    expect(peerChip(undefined, undefined)).toMatchObject({ label: "Unnamed · unreachable", level: "fail" });
  });
});

describe("peerChips", () => {
  it("is empty when no peers are enrolled or health has not said", () => {
    expect(peerChips(undefined, "0.3.53")).toEqual([]);
    expect(peerChips({ peers: { configured: false, computers: [] } }, "0.3.53")).toEqual([]);
    expect(peerChips({ peers: { configured: true } }, "0.3.53")).toEqual([]);
  });

  it("makes one chip per peer", () => {
    const chips = peerChips({ peers: { configured: true, computers: [{ name: "A", reachable: true, ms: 1 }, { name: "B", reachable: false }] } }, "0.3.53");
    expect(chips.map((c: { label: string }) => c.label)).toEqual(["A · 1 ms", "B · unreachable"]);
  });
});
