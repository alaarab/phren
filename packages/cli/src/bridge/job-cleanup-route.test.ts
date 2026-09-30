import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRouteHandler } from "./server-routes.js";

describe("POST /v1/jobs/cleanup", () => {
  it("runs the registry's safe cleanup and reports what it did", async () => {
    let called = 0;
    const handler = createRouteHandler({ modules: { has: () => true }, info: {}, streams: {},
      agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set() },
      journal: { record: async () => {} }, tabActivity: { observe: async () => new Map() },
      contextUsage: { read: async () => new Map() },
      resources: { cleanupJobs: async () => { called++; return { killed: [4242], kept: [{ pgid: 1, reason: "self" }], forgotten: [9] }; } },
    } as never);
    let result = "";
    const response = { statusCode: 200, setHeader() {}, end(value: string) { result = value; } };
    const request = { url: "/v1/jobs/cleanup", method: "POST", [Symbol.asyncIterator]: async function* () { yield Buffer.from("{}"); } };
    await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    expect(response.statusCode, result).toBe(200);
    expect(called).toBe(1);
    expect(JSON.parse(result)).toEqual({ ok: true, killed: [4242], kept: [{ pgid: 1, reason: "self" }], forgotten: [9] });
  });
});
