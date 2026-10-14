import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM UI module
import { needsNotice, sendReply } from "../ui/shell/needs-notify.js";

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
  "password=short-secret", 'api_key="two words"', "deadbeef".repeat(8), "aB9+/".repeat(12) + "==",
])("redacts credentials before constructing a notification: %s", (secret) => {
  const notice = needsNotice(row({ lastReply: `Use ${secret} now. Tests pass.` }));
  expect(notice.body).not.toContain(secret);
  expect(notice.body).toContain("[redacted]");
  expect(notice.body).toContain("now. Tests pass.");
});
