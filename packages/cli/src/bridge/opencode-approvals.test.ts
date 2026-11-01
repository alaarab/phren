import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { opencodeApprovalFile, readOpencodeRequest } from "./opencode-approvals.js";

const session = "ses_f4a6b5c11ffe6nZrRlGZbXXNli";

describe("opencodeApprovalFile", () => {
  it("puts a valid session's request and answer under the store's approvals folder", () => {
    const store = "/phren/store";
    expect(opencodeApprovalFile(session, "request", store))
      .toBe(path.join(store, ".runtime", "approvals", `opencode-${session}.request.json`));
    expect(opencodeApprovalFile(session, "answer", store))
      .toBe(path.join(store, ".runtime", "approvals", `opencode-${session}.answer.json`));
  });

  const unsafe = ["", "ses_", "ses_bad-name", "ses_bad.name", "ses_ok/../escape", `ses_${"a".repeat(65)}`,
    "f4a6b5c11ffe6nZrRlGZbXXNli"];
  it.each(unsafe)("refuses the unsafe session %j", (value: string) => {
    expect(opencodeApprovalFile(value, "request", "/phren/store")).toBeUndefined();
  });
});

describe("readOpencodeRequest", () => {
  let store = "";
  const requestFile = () => path.join(store, ".runtime", "approvals", `opencode-${session}.request.json`);
  beforeEach(async () => {
    store = await mkdtemp(path.join(tmpdir(), "phren-opencode-approvals-"));
    await mkdir(path.dirname(requestFile()), { recursive: true });
  });
  afterEach(async () => { await rm(store, { recursive: true, force: true }); });

  const live = { id: "per_abc123", sessionID: session, type: "bash", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const cases: [name: string, content: unknown, expected: unknown][] = [
    ["a live request", live, live],
    ["a request for another session", { ...live, sessionID: "ses_other" }, undefined],
    ["a request with no id", { ...live, id: undefined }, undefined],
    ["a request with an empty id", { ...live, id: "" }, undefined],
    ["an expired request", { ...live, expiresAt: new Date(Date.now() - 1_000).toISOString() }, undefined],
    ["a request with an unparsable expiry", { ...live, expiresAt: "tomorrow" }, undefined],
    ["a request with a numeric expiry", { ...live, expiresAt: Date.now() + 3_600_000 }, undefined],
  ];
  it.each(cases)("returns %s when it is live, else nothing", async (_name, content, expected) => {
    await writeFile(requestFile(), JSON.stringify(content));
    expect(await readOpencodeRequest(session, store)).toEqual(expected);
  });

  it("refuses an oversized request file before parsing it", async () => {
    await writeFile(requestFile(), "x".repeat(65_537));
    expect(await readOpencodeRequest(session, store)).toBeUndefined();
  });

  it("refuses a request path that is not a file", async () => {
    await mkdir(requestFile(), { recursive: true });
    expect(await readOpencodeRequest(session, store)).toBeUndefined();
  });

  it("never resolves a request for a session that could escape the approvals folder", async () => {
    expect(await readOpencodeRequest("ses_ok/../escape", store)).toBeUndefined();
  });
});
