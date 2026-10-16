import { describe, expect, it } from "vitest";
import { countChanges, pullIdentity, syncResultMessage, throttleLeft } from "../ui/store-sync.js";

describe("syncResultMessage", () => {
  it("says up to date when nothing moved", () => {
    expect(syncResultMessage({ changed: false })).toBe("Up to date");
    expect(syncResultMessage({ changed: true, changes: 0 })).toBe("Up to date");
  });
  it("counts the pulled changes", () => {
    expect(syncResultMessage({ changed: true, changes: 1 })).toBe("Pulled 1 change");
    expect(syncResultMessage({ changed: true, changes: 3 })).toBe("Pulled 3 changes");
    expect(syncResultMessage({ changed: true, changes: null })).toBe("Pulled changes");
  });
  it("shows the Hook's message, and explains its bare 404", () => {
    expect(syncResultMessage({ error: Object.assign(new Error("Only the owner or a peer Hook can request a pull."), { status: 403 }) }))
      .toBe("Only the owner or a peer Hook can request a pull.");
    expect(syncResultMessage({ error: Object.assign(new Error("Not found."), { status: 404 }) })).toBe("This store has no matching remote branch to pull.");
  });
});

describe("countChanges", () => {
  it("counts added, removed and changed files", () => {
    const blob = (path: string, sha: string) => ({ path, sha, type: "blob" });
    const before = [blob("a/FINDINGS.md", "1"), blob("a/tasks.md", "2"), blob("b/summary.md", "3"), { path: "a", sha: "x", type: "tree" }];
    const after = [blob("a/FINDINGS.md", "9"), blob("a/tasks.md", "2"), blob("c/new.md", "4")];
    expect(countChanges(before, after)).toBe(3);
  });
});

describe("throttleLeft", () => {
  it("allows a first sync and blocks repeats for ten seconds", () => {
    expect(throttleLeft(undefined as unknown as number, 1000)).toBe(0);
    expect(throttleLeft(1000, 4000)).toBe(7000);
    expect(throttleLeft(1000, 11_000)).toBe(0);
  });
});

describe("pullIdentity", () => {
  it("names the primary store by id, repository and branch", () => {
    expect(pullIdentity({ stores: [{ id: "x1", primary: false }, { id: "ab12cd34", primary: true, repositoryIdentity: { repository: "me/memory", branch: "main" } }] }))
      .toEqual({ storeId: "ab12cd34", repository: "me/memory", branch: "main" });
    expect(pullIdentity({ stores: [{ id: "ab12cd34", primary: true }] })).toBeNull();
  });
});
