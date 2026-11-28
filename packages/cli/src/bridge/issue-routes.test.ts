import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeError, type Issue, type IssueEdit, type NewIssue } from "../forge/issues.js";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { ISSUES_RESPONSE_LIMIT, LIST_BODY_LIMIT, resetIssueRouteCache, resetIssueRouteDeps, setIssueRouteDeps, type IssueRouteDeps } from "./issue-routes.js";
import { OWNER_PROOF_HEADER } from "./owner-proof.js";
import type { Json } from "./protocol.js";
import { capabilitiesForModules, createRouteHandler } from "./server-routes.js";

/** The real issue routes with a faked forge: ownership, error mapping, the
 * default repo set and the response caps. No forge or gh call is made. */

const modules = { has: () => true, modules: BUILTIN_MODULES };

function handler(store: string) {
  return createRouteHandler({ modules: { ...modules, store }, info: { computer: { id: "00000000-0000-4000-8000-0000000000aa", name: "self" }, capabilities: capabilitiesForModules(modules as never) },
    accountUsage: { read: async () => ({ accounts: [] }) }, streams: {} } as never);
}

async function request(method: string, url: string, body?: Json, headers: Record<string, string> = {}, store = ""): Promise<{ status: number; body: Json }> {
  const handlerFn = handler(store);
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as IncomingMessage;
  req.method = method; req.url = url; req.headers = headers;
  let payload = "";
  const res = { statusCode: 200, setHeader() {}, end(value: string) { payload = value; } };
  await handlerFn(req, res as unknown as ServerResponse);
  return { status: res.statusCode, body: payload ? JSON.parse(payload) as Json : {} };
}

function issue(number: number, overrides: Partial<Issue> = {}): Issue {
  return { repo: "github.com/example/widgets", number, url: `https://github.com/example/widgets/issues/${number}`, title: `Issue ${number}`,
    body: "", state: "open", labels: [], assignees: [], checklist: [], updatedAt: "2026-11-27T00:00:00Z", createdAt: "2026-11-27T00:00:00Z", ...overrides };
}

/** A paired-phone key and the signed envelope the Hook verifies. */
const phone = generateKeyPairSync("ed25519");
const phoneRaw = phone.publicKey.export({ format: "der", type: "spki" }).subarray(12);
const PHONE_WIRE = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), phoneRaw]);
const AUTHORIZED_KEYS = `restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ssh-ed25519 ${PHONE_WIRE.toString("base64")} phren-iphone\n`;
function proofHeader(method: string, pathname: string, raw: string): string {
  const payload = Buffer.from(JSON.stringify({
    domain: "phren-owner-request-v1", nonce: randomUUID(), at: new Date().toISOString(),
    method, path: pathname, body: createHash("sha256").update(raw).digest("hex"),
  }));
  return Buffer.from(JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, phone.privateKey).toString("base64"),
    publicKey: phoneRaw.toString("base64") })).toString("base64url");
}

let root: string, store: string, bridge: string, home: string;
let restore: (() => void) | undefined;
const forged: Partial<IssueRouteDeps> = {
  list: async () => ({ issues: [], errors: [] }),
  get: async ref => issue(ref.number),
  create: async (input: NewIssue) => issue(1, { repo: input.repo, title: input.title }),
  edit: async (ref, edit: IssueEdit) => issue(ref.number, edit),
  comment: async () => ({ url: "https://github.com/example/widgets/issues/1#issuecomment-1" }),
  claim: async ref => issue(ref.number, { claimedBy: { computer: "self" } }),
  close: async ref => issue(ref.number, { state: "closed" }),
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-issues-"));
  store = path.join(root, "store");
  bridge = path.join(root, "bridge"); home = path.join(root, "home");
  await mkdir(store, { recursive: true });
  await mkdir(bridge, { recursive: true });
  await mkdir(path.join(home, ".ssh"), { recursive: true });
  await writeFile(path.join(home, ".ssh", "authorized_keys"), AUTHORIZED_KEYS);
  // The phone has signed once: unsigned writes to these routes are refused.
  await writeFile(path.join(bridge, "owner-proof.json"), "{}");
  vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
  vi.stubEnv("HOME", home);
  restore = setIssueRouteDeps(forged);
  resetIssueRouteCache();
});
afterEach(async () => {
  restore?.(); restore = undefined;
  resetIssueRouteDeps();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("issue routes are owner-only", () => {
  it("advertises the issues capability", () => {
    expect(capabilitiesForModules(modules as never).issues).toBe(1);
  });

  it("serves the owner's list and item reads", async () => {
    restore = setIssueRouteDeps({ ...forged, list: async () => ({ issues: [issue(7)], errors: [] }) });
    const list = await request("GET", "/v1/issues?repos=github.com/example/widgets", undefined, {}, store);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ issues: [{ number: 7 }], errors: [], truncated: false });
    const item = await request("GET", "/v1/issues/item?repo=github.com/example/widgets&number=7", undefined, {}, store);
    expect(item.status).toBe(200);
    expect(item.body).toMatchObject({ issue: { number: 7, repo: "github.com/example/widgets" } });
  });

  const refused: { method: string; url: string; body?: Json; headers: Record<string, string> }[] = [
    { method: "GET", url: "/v1/issues", headers: { "x-phren-origin": "peer" } },
    { method: "GET", url: "/v1/issues", headers: { "x-phren-origin": "agent" } },
    { method: "GET", url: "/v1/issues/item?repo=github.com/example/widgets&number=7", headers: { "x-phren-origin": "peer" } },
    { method: "POST", url: "/v1/issues/comment", body: { repo: "github.com/example/widgets", number: 7, body: "hi" }, headers: { "x-phren-origin": "peer" } },
    { method: "POST", url: "/v1/issues/create", body: { repo: "github.com/example/widgets", title: "T", origin: { pane: "1" } }, headers: {} },
  ];
  it.each(refused)("refuses $method $url from $headers", async ({ method, url, body, headers }) => {
    const answer = await request(method, url, body, headers, store);
    expect(answer.status).toBe(403);
  });

  it("refuses an unsigned write once the phone has signed before", async () => {
    const answer = await request("POST", "/v1/issues/create", { repo: "github.com/example/widgets", title: "T" }, {}, store);
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ code: "owner-proof-required" });
  });

  it("accepts a signed write, and claims for this computer", async () => {
    const claims: { number: number; computer: string }[] = [];
    restore = setIssueRouteDeps({ ...forged, claim: async (ref, computer) => { claims.push({ number: ref.number, computer }); return issue(ref.number); } });
    const create = { repo: "github.com/example/widgets", title: "New from the phone" };
    const created = await request("POST", "/v1/issues/create", create, { [OWNER_PROOF_HEADER]: proofHeader("POST", "/v1/issues/create", JSON.stringify(create)) }, store);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, issue: { title: "New from the phone" } });
    const claim = { repo: "github.com/example/widgets", number: 7 };
    const claimed = await request("POST", "/v1/issues/claim", claim, { [OWNER_PROOF_HEADER]: proofHeader("POST", "/v1/issues/claim", JSON.stringify(claim)) }, store);
    expect(claimed.status).toBe(200);
    expect(claims).toEqual([{ number: 7, computer: "self" }]);
  });
});

describe("forge errors map to HTTP statuses", () => {
  const cases: { code: ForgeError["code"]; status: number }[] = [
    { code: "auth", status: 502 }, { code: "not-found", status: 404 }, { code: "forbidden", status: 403 },
    { code: "rate-limited", status: 429 }, { code: "unavailable", status: 503 }, { code: "invalid", status: 400 },
  ];
  it.each(cases)("$code becomes $status", async ({ code, status }) => {
    restore = setIssueRouteDeps({ ...forged, get: async () => { throw new ForgeError(code, "The forge said no."); } });
    const answer = await request("GET", "/v1/issues/item?repo=github.com/example/widgets&number=7", undefined, {}, store);
    expect(answer.status).toBe(status);
    expect(answer.body).toMatchObject({ error: "The forge said no.", code: `forge-${code}` });
  });

  it("maps an invalid repository on a write to 400", async () => {
    const body = { repo: "not a repo", title: "T" };
    const answer = await request("POST", "/v1/issues/create", body, { [OWNER_PROOF_HEADER]: proofHeader("POST", "/v1/issues/create", JSON.stringify(body)) }, store);
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ code: "forge-invalid" });
  });
});

describe("the default repo set", () => {
  it("uses every store project's resolvable repo, cached for five minutes", async () => {
    for (const [project, config] of [["zissue-one", "issues: gitboy.dev/example/one\n"], ["zissue-two", "issues: github.com/example/two\n"], ["zissue-none", ""]] as const) {
      await mkdir(path.join(store, project), { recursive: true });
      if (config) await writeFile(path.join(store, project, "phren.project.yaml"), config);
    }
    let clock = 1_000_000;
    const repos: string[][] = [];
    restore = setIssueRouteDeps({ ...forged, now: () => clock, list: async query => { repos.push([...query.repos ?? []]); return { issues: [], errors: [] }; } });

    expect((await request("GET", "/v1/issues", undefined, {}, store)).status).toBe(200);
    expect(repos[0].sort()).toEqual(["gitboy.dev/example/one", "github.com/example/two"]);

    // A named repo skips the walk entirely.
    await request("GET", "/v1/issues?repos=github.com/example/explicit", undefined, {}, store);
    expect(repos[1]).toEqual(["github.com/example/explicit"]);

    // Still inside the window: a changed setting is not read again.
    await writeFile(path.join(store, "zissue-two", "phren.project.yaml"), "issues: github.com/example/changed\n");
    clock += 60_000;
    await request("GET", "/v1/issues", undefined, {}, store);
    expect(repos[2].sort()).toEqual(["gitboy.dev/example/one", "github.com/example/two"]);

    // Past five minutes: the walk runs again and sees the change.
    clock += 5 * 60_000;
    await request("GET", "/v1/issues", undefined, {}, store);
    expect(repos[3].sort()).toEqual(["gitboy.dev/example/one", "github.com/example/changed"]);
  });
});

describe("list bodies stay small", () => {
  it("trims a long body and marks it", async () => {
    restore = setIssueRouteDeps({ ...forged, list: async () => ({ issues: [issue(1, { body: "x".repeat(3_000) }), issue(2, { body: "y".repeat(LIST_BODY_LIMIT) })], errors: [] }) });
    const answer = await request("GET", "/v1/issues?repos=github.com/example/widgets", undefined, {}, store);
    const rows = answer.body.issues as Json[];
    expect(String(rows[0].body)).toHaveLength(LIST_BODY_LIMIT);
    expect(rows[0].truncated).toBe(true);
    expect(String(rows[1].body)).toHaveLength(LIST_BODY_LIMIT);
    expect(rows[1].truncated).toBeUndefined();
    expect(answer.body.truncated).toBe(false);
  });

  it("drops rows past the 256 KB cap and says so", async () => {
    const issues = Array.from({ length: 200 }, (_, index) => issue(index + 1, { body: "z".repeat(4_000) }));
    restore = setIssueRouteDeps({ ...forged, list: async () => ({ issues, errors: [] }) });
    const answer = await request("GET", "/v1/issues?repos=github.com/example/widgets&limit=200", undefined, {}, store);
    const rows = answer.body.issues as Json[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(issues.length);
    expect(answer.body.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(answer.body))).toBeLessThanOrEqual(ISSUES_RESPONSE_LIMIT);
  });
});
