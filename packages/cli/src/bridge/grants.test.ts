import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addGrant, ensureGrant, listGrants, matchGrant, removeGrant, type Grant } from "./grants.js";
import { BridgeError } from "./protocol.js";

const now = Date.parse("2026-09-21T12:00:00.000Z");
const future = "2026-10-01T00:00:00.000Z";
const past = "2026-09-01T00:00:00.000Z";

function grant(overrides: Partial<Grant> = {}): Grant {
  return { scope: "global", actions: ["dispatch", "hand_off"], ...overrides };
}

describe("conductor grants", () => {
  let root: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    root = await mkdtemp(path.join(tmpdir(), "phren-grants-"));
  });
  afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

  it("preserves concurrent additions and rejects stale revoke indexes", async () => {
    const first = { scope: "project:first", actions: ["dispatch"] };
    const second = { scope: "project:second", actions: ["hand_off"] };
    await Promise.all([addGrant(first, root), addGrant(second, root)]);
    expect(await listGrants(root)).toHaveLength(2);
    await removeGrant({ index: 0, expected: first }, root);
    await expect(removeGrant({ index: 0, expected: first }, root)).rejects.toMatchObject({ status: 409 });
    expect(await listGrants(root)).toEqual([second]);
  });

  it("matches by specificity: project beats global, named computers beat any, most specific wins", () => {
    const globalAny = grant();
    const projectAny = grant({ scope: "project:phren" });
    const projectDesk = grant({ scope: "project:phren", computers: ["Desk"] });
    const globalDesk = grant({ computers: ["Desk"] });
    const grants = [globalAny, projectAny, projectDesk, globalDesk];

    expect(matchGrant(grants, { action: "dispatch", project: "phren", computer: "Desk" }, now)).toBe(projectDesk);
    expect(matchGrant(grants, { action: "dispatch", project: "phren", computer: "Linuxbox" }, now)).toBe(projectAny);
    expect(matchGrant(grants, { action: "dispatch", project: "other", computer: "Desk" }, now)).toBe(globalDesk);
    expect(matchGrant(grants, { action: "dispatch", project: "other", computer: "Linuxbox" }, now)).toBe(globalAny);
  });

  it("never covers an unresolved destination with a computers-restricted grant", () => {
    const restricted = grant({ computers: ["Desk"] });
    expect(matchGrant([restricted], { action: "dispatch", computer: "Desk" }, now)).toBe(restricted);
    expect(matchGrant([restricted], { action: "dispatch", computer: "anywhere" }, now)).toBeUndefined();
    expect(matchGrant([restricted], { action: "dispatch" }, now)).toBeUndefined();
    expect(matchGrant([restricted], { action: "dispatch", computer: "Linuxbox" }, now)).toBeUndefined();
  });

  it("filters expired grants at list and match time and keeps action scope tight", async () => {
    await writeFile(path.join(root, "conductor.yaml"), [
      "grants:",
      "  - scope: project:phren",
      "    actions: [dispatch]",
      "    until: 2026-10-01T00:00Z",
      "  - scope: global",
      "    actions: [hand_off]",
      "    until: 2026-09-01T00:00Z",
      "",
    ].join("\n"), { mode: 0o600 });
    await chmod(path.join(root, "conductor.yaml"), 0o600);

    const listed = await listGrants(root);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ scope: "project:phren", actions: ["dispatch"], until: future });
    expect(matchGrant(listed, { action: "dispatch", project: "phren" }, now)).toMatchObject({ scope: "project:phren" });
    expect(matchGrant(listed, { action: "hand_off", project: "phren" }, now)).toBeUndefined();
    expect(matchGrant(listed, { action: "dispatch", project: "phren" }, Date.parse(future) + 1)).toBeUndefined();
  });

  it("adds, is idempotent under ensureGrant, and refuses exact duplicates under addGrant", async () => {
    const input = { scope: "project:phren", actions: ["dispatch"] as const };
    expect(await addGrant(input, root)).toMatchObject(input);
    expect(await ensureGrant(input, root)).toMatchObject(input);
    expect(await listGrants(root)).toHaveLength(1);
    await expect(addGrant(input, root)).rejects.toMatchObject({ status: 409 });
    expect(await ensureGrant({ ...input, actions: ["dispatch", "hand_off"] }, root)).toMatchObject({ actions: ["dispatch", "hand_off"] });
    expect(await listGrants(root)).toHaveLength(2);
  });

  it("removes by scope with optional set filters and never invents default actions", async () => {
    await addGrant({ scope: "global", actions: ["dispatch"] }, root);
    await addGrant({ scope: "global", actions: ["hand_off"] }, root);
    await addGrant({ scope: "project:phren", actions: ["dispatch", "hand_off"], computers: ["Desk"] }, root);

    const removed = await removeGrant({ scope: "project:phren", computers: ["Desk"] }, root);
    expect(removed).toMatchObject({ scope: "project:phren", computers: ["Desk"] });
    expect(await listGrants(root)).toHaveLength(2);

    // Scope alone takes the first row with that scope; actions refine when given.
    const byScope = await removeGrant({ scope: "global" }, root);
    expect(byScope.actions).toEqual(["dispatch"]);
    const byActions = await removeGrant({ scope: "global", actions: ["hand_off"] }, root);
    expect(byActions.actions).toEqual(["hand_off"]);
    expect(await listGrants(root)).toHaveLength(0);

    await expect(removeGrant({ scope: "global" }, root)).rejects.toBeInstanceOf(BridgeError);
    await expect(removeGrant({ scope: "global" }, root)).rejects.toMatchObject({ status: 404 });
    await expect(removeGrant({ actions: ["dispatch"] }, root)).rejects.toThrow();
  });

  it("rejects a conductor.yaml that is not a private regular file", async () => {
    await writeFile(path.join(root, "conductor.yaml"), "grants: []\n", { mode: 0o644 });
    await expect(listGrants(root)).rejects.toMatchObject({ status: 409 });
    await expect(listGrants(root)).rejects.toThrow("0600");
  });
});
