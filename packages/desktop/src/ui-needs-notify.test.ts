import { describe, expect, it } from "vitest";
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
