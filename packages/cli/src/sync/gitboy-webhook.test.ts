import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { DeliveryLog, parseGitboyPush, storePushMatches, verifyGitboySignature } from "./gitboy-webhook.js";

const SECRET = "example-shared-secret";
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function pushBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    repository: { id: "r1", name: "notes", full_name: "example/notes", private: true },
    pusher: { id: "u1" },
    updates: [{ ref: "refs/heads/main", old: OLD, new: NEW, changed_paths: ["global/FINDINGS.md"], changed_paths_truncated: false }],
    ...overrides,
  }));
}

const pushHeaders = { "X-Gitboy-Event": "push", "X-Gitboy-Delivery": "d-1" };

describe("verifyGitboySignature", () => {
  const body = pushBody();

  it("accepts the HMAC of the exact body", () => {
    expect(verifyGitboySignature(SECRET, body, sign(body))).toBe(true);
    expect(verifyGitboySignature(SECRET, body, sign(body).toUpperCase().replace("SHA256=", "sha256="))).toBe(true);
  });

  it("rejects a wrong secret, a tampered body and an empty secret", () => {
    expect(verifyGitboySignature("other-secret", body, sign(body))).toBe(false);
    const tampered = Buffer.from(body.toString("utf8").replace("main", "mainx"));
    expect(verifyGitboySignature(SECRET, tampered, sign(body))).toBe(false);
    expect(verifyGitboySignature("", body, sign(body, ""))).toBe(false);
  });

  it("rejects missing and malformed headers", () => {
    const hex = sign(body).slice("sha256=".length);
    for (const header of [undefined, "", hex, `sha1=${hex}`, "sha256=", `sha256=${hex.slice(2)}`, `sha256=${hex}00`, `sha256=${"z".repeat(64)}`]) {
      expect(verifyGitboySignature(SECRET, body, header)).toBe(false);
    }
  });
});

describe("parseGitboyPush", () => {
  it("parses a push with headers in any case", () => {
    const push = parseGitboyPush(pushBody(), { "x-gitboy-event": "push", "x-gitboy-delivery": ["d-9"] });
    expect(push).toEqual({
      deliveryId: "d-9",
      event: "push",
      repository: { owner: "example", name: "notes" },
      updates: [{ ref: "refs/heads/main", old: OLD, new: NEW, changedPaths: ["global/FINDINGS.md"], truncated: false }],
    });
  });

  it("returns null for other events, a missing delivery id and malformed bodies", () => {
    expect(parseGitboyPush(pushBody(), { ...pushHeaders, "X-Gitboy-Event": "tag" })).toBeNull();
    expect(parseGitboyPush(pushBody(), { "X-Gitboy-Event": "push" })).toBeNull();
    expect(parseGitboyPush(Buffer.from("{not json"), pushHeaders)).toBeNull();
    expect(parseGitboyPush(Buffer.from("[]"), pushHeaders)).toBeNull();
    expect(parseGitboyPush(Buffer.from(JSON.stringify({ repository: {} })), pushHeaders)).toBeNull();
  });

  it("keeps null and truncated changed paths and drops malformed updates", () => {
    const push = parseGitboyPush(pushBody({
      updates: [
        { ref: "refs/heads/new", old: "0".repeat(40), new: NEW, changed_paths: null },
        { ref: "refs/heads/main", old: OLD, new: NEW, changed_paths: ["a.md"], changed_paths_truncated: true },
        { ref: "refs/heads/odd", old: OLD, new: NEW, changed_paths: [1, 2] },
        { ref: 5, old: OLD, new: NEW },
        "garbage",
      ],
    }), pushHeaders);
    expect(push?.updates).toEqual([
      { ref: "refs/heads/new", old: "0".repeat(40), new: NEW, changedPaths: null, truncated: false },
      { ref: "refs/heads/main", old: OLD, new: NEW, changedPaths: ["a.md"], truncated: true },
      { ref: "refs/heads/odd", old: OLD, new: NEW, changedPaths: null, truncated: false },
    ]);
  });

  it("leaves the repository null when full_name is missing or malformed", () => {
    for (const repository of [undefined, { id: "r1", name: "notes" }, { full_name: "notes" }, { full_name: "/notes" }, { full_name: "a/b/c" }]) {
      expect(parseGitboyPush(pushBody({ repository }), pushHeaders)?.repository).toBeNull();
    }
  });
});

describe("storePushMatches", () => {
  const store = { owner: "example", name: "notes", branch: "main" };
  const parse = (overrides: Record<string, unknown> = {}) => parseGitboyPush(pushBody(overrides), pushHeaders)!;

  it("matches the store's repository and branch, repository case-insensitively", () => {
    expect(storePushMatches(parse(), store)).toBe(true);
    expect(storePushMatches(parse(), { owner: "Example", name: "NOTES", branch: "main" })).toBe(true);
  });

  it("ignores other branches, tags, branch case, other repositories and unknown repositories", () => {
    const update = (ref: string) => ({ updates: [{ ref, old: OLD, new: NEW, changed_paths: null }] });
    expect(storePushMatches(parse(update("refs/heads/dev")), store)).toBe(false);
    expect(storePushMatches(parse(update("refs/tags/main")), store)).toBe(false);
    expect(storePushMatches(parse(update("refs/heads/Main")), store)).toBe(false);
    expect(storePushMatches(parse(update("main")), store)).toBe(false);
    expect(storePushMatches(parse(), { ...store, name: "other" })).toBe(false);
    expect(storePushMatches(parse(), { ...store, owner: "someone" })).toBe(false);
    expect(storePushMatches(parse({ repository: null }), store)).toBe(false);
    expect(storePushMatches(parse(), { ...store, branch: "" })).toBe(false);
  });

  it("matches when the store's branch is one of several updates", () => {
    const push = parse({ updates: [
      { ref: "refs/tags/v1", old: "0".repeat(40), new: NEW, changed_paths: null },
      { ref: "refs/heads/main", old: OLD, new: NEW, changed_paths: null },
    ] });
    expect(storePushMatches(push, store)).toBe(true);
  });
});

describe("DeliveryLog", () => {
  it("reports retries of the same delivery as seen", () => {
    const log = new DeliveryLog();
    expect(log.seen("d-1")).toBe(false);
    expect(log.seen("d-1")).toBe(true);
    expect(log.seen("d-2")).toBe(false);
  });

  it("evicts the oldest ids beyond its capacity", () => {
    const log = new DeliveryLog(3);
    for (const id of ["a", "b", "c", "d"]) log.seen(id);
    expect(log.size).toBe(3);
    expect(log.seen("b")).toBe(true);
    expect(log.seen("a")).toBe(false);
  });

  it("holds 1,000 ids by default", () => {
    const log = new DeliveryLog();
    for (let i = 0; i <= 1_000; i++) log.seen(`d-${i}`);
    expect(log.size).toBe(1_000);
    expect(log.seen("d-1000")).toBe(true);
    expect(log.seen("d-0")).toBe(false);
  });
});
