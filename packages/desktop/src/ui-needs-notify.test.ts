import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM UI module
import { needsNotice, sendReply } from "../ui/shell/needs-notify.js";

// Quadratic redaction needs seconds on these fillers; the budget is wide enough for a loaded CI runner.
const NOTICE_BUDGET_MS = 3000;

const row = (child: Record<string, unknown>) => ({
  key: "mini/7", computer: "mini",
  child: { id: "7", label: "claude", title: "Ship it", cwd: "/home/you/phren", target: { session: "s7", pane: "2" }, agentStatus: "waiting", ...child },
});

describe("needsNotice", () => {
  it("offers a reply only to an agent that is simply waiting on you", () => {
    expect(needsNotice(row({}))).toEqual({ title: "phren needs you", body: "Ship it · mini", key: "mini/7", reply: true });
    expect(needsNotice(row({ approvalPending: true })).reply).toBe(false);
    expect(needsNotice(row({ agentStatus: "blocked" })).reply).toBe(false);
  });

  it("adds what the agent said last when the Hook sends it", () => {
    expect(needsNotice(row({ lastReply: "Tests pass. Merge it?" })).body).toBe("Ship it · mini\nTests pass. Merge it?");
  });
});

describe("sendReply", () => {
  it("sends the text as the session's next prompt", async () => {
    const posts: unknown[] = [];
    const error = await sendReply("mini/7", "yes, ship it", { find: () => row({}), post: async (...args: unknown[]) => { posts.push(args); } });
    expect(error).toBe("");
    expect(posts).toEqual([["mini", "/v1/prompt", { target: { session: "s7", pane: "2" }, text: "yes, ship it", deliveryId: expect.any(String) }]]);
  });

  it("says why when the session is gone or the Hook refuses", async () => {
    expect(await sendReply("mini/7", "hi", { find: () => undefined })).toBe("That session is gone.");
    expect(await sendReply("mini/7", "hi", { find: () => row({}), post: async () => { throw new Error("pane closed"); } })).toBe("pane closed");
  });
});


it.each([
  "Authorization: Bearer abc.def.ghi", `sk-${"a".repeat(30)}`, `ghp_${"a".repeat(36)}`,
  `github_pat_${"a".repeat(40)}`, "xoxb-1234567890-secret", "AKIA1234567890ABCDEF",
  "password=short-secret", 'api_key="two words"', "deadbeef".repeat(6), "aB9+/".repeat(12) + "==",
  "https://alice:swordfish@internal.example/api", "redis://:swordfish@localhost:6379", '{"password":"swordfish"}',
  "DB_PASSWORD=swordfish", '"api_key": "short-key"', "glpat-" + "x".repeat(20), "npm_" + "A1b2".repeat(9),
  "sk_live_" + "Ab12".repeat(6), "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "/JalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "AccountKey=/9Zx8Wv7Ut6Sr5Qp4On3Ml2Kj1Ih0Gf==", "dop_v1_" + "abcdef0123456789".repeat(4),
  "Authorization: Basic YWxpY2U6c3dvcmRmaXNo", "Authorization: Token swordfish",
  '{"password":"alpha\\"omega"}', "accessToken=swordfish123",
  "PGPASSWORD=swordfish", "MYSQL_PWD=hunter2", "SECRET_KEY=django-insecure-example-secret-value!",
  "Server=db;User ID=alice;Pwd=swordfish;", "https://acct.blob.core.windows.net/c?sv=2022&sig=aB9Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Ab4C%3D",
  "Authorization: AWS4-HMAC-SHA256 Credential=ASIAIOSFODNN7EXAMPLE/20261014/us-east-1/s3/aws4_request, Signature=" + "ab12".repeat(16),
])("redacts credentials before constructing a notification: %s", (secret) => {
  const notice = needsNotice(row({ lastReply: `Use ${secret} now. Tests pass.` }));
  expect(notice.body).not.toContain(secret);
  expect(notice.body).toContain("[redacted]");
  expect(notice.body).toContain("now. Tests pass.");
});

it.each([
  "Cherry-pick 0123456789abcdef0123456789abcdef01234567 then retry.",
  "Look at /Users/sam/Projects/phren-w1e/packages/desktop/ui/shell/needs-notify.js line 40.",
  "Edit packages/desktop/ui/shell/needs-notify.js and src/ui-needs-notify.test.ts.",
  "The token budget is fine and tokens are counted per turn.",
  "The CancellationToken: None means no cancellation.",
  "Merged at 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 on main.",
])("keeps ordinary references readable: %s", (text) => {
  expect(needsNotice(row({ lastReply: text })).body).toContain(text.slice(0, 60));
});

it("redacts a long reply in bounded time", () => {
  const started = performance.now();
  for (const filler of ["a.".repeat(64_000) + "!", "_".repeat(64_000), ("ab" + "/").repeat(40_000)]) {
    needsNotice(row({ lastReply: filler }));
  }
  expect(performance.now() - started).toBeLessThan(NOTICE_BUDGET_MS);
});

it("never leaks the start of a secret cut by the notification length", () => {
  for (const tail of [' password="swordfish-and-more-text"', " https://alice:swordfish@internal.example/api", ` ghp_${"a".repeat(36)}`]) {
    for (let pad = 360; pad <= 400; pad += 4) {
      const body = needsNotice(row({ lastReply: "x".repeat(pad) + tail })).body;
      expect(body).not.toContain("swordfish");
      expect(body).not.toMatch(/ghp_a/);
    }
  }
});
