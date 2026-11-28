import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRouteHandler } from "./server-routes.js";
import { TASKS_RETIRED_CODE, TASKS_RETIRED_MESSAGE } from "../task/retired.js";

const ROUTES = ["/v1/tasks/create", "/v1/tasks/update", "/v1/tasks/save", "/v1/tasks/launch"];

describe("phone task writes", () => {
  it.each(ROUTES)("%s answers 410 tasks-retired", async (route) => {
    const handler = createRouteHandler({ modules: { has: () => true }, info: {}, streams: {},
      agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set() },
      journal: { record: async () => {} },
      tabActivity: { observe: async () => ({ generation: 0, stamps: new Map() }), recordStatus: async () => new Map() },
      contextUsage: { read: async () => new Map() },
    } as never);
    let result = "";
    const response = { statusCode: 200, setHeader() {}, end(value: string) { result = value; } };
    const request = { url: route, method: "POST", [Symbol.asyncIterator]: async function* () { yield Buffer.from("{}"); } };
    await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    expect(response.statusCode, result).toBe(410);
    expect(JSON.parse(result)).toEqual({ error: TASKS_RETIRED_MESSAGE, code: TASKS_RETIRED_CODE });
  });
});
