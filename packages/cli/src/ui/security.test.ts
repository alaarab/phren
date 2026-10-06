import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { makeTempDir } from "../test-helpers.js";
import { createWebUiHttpServer } from "./server.js";

describe("web UI request failure isolation", () => {
  let server: http.Server;
  let cleanup: () => void;
  let port: number;
  let failRender: boolean;
  const authToken = "test-only-auth-token";

  beforeEach(async () => {
    const temp = makeTempDir("phren-web-security-");
    cleanup = temp.cleanup;
    failRender = false;
    server = createWebUiHttpServer(temp.path, () => {
      if (failRender) throw new Error("private implementation detail");
      return "healthy";
    }, undefined, { authToken });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    port = address.port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup();
  });

  function request(method: string, path: string, authenticated = false): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port, method, path,
        headers: authenticated ? { authorization: `Bearer ${authToken}` } : {},
      }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      });
      req.setTimeout(2000, () => req.destroy(new Error("Request timed out")));
      req.on("error", reject);
      req.end();
    });
  }

  it.each(["findings", "notes"])("rejects malformed %s paths and keeps serving requests", async (resource) => {
    // Writes parse the project before their form-based auth check. Even a
    // request without credentials must never cause an unhandled rejection.
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await request(method, `/api/${resource}/%`);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body).error).toBe("Invalid URL encoding");
    }
    expect((await request("GET", `/api/${resource}/%`)).status).toBe(401);
    expect((await request("GET", `/api/${resource}/%E0%A4%A`, true)).status).toBe(400);
    expect(await request("GET", "/", true)).toEqual({ status: 200, body: "healthy" });
  });

  it("contains unexpected route failures without exposing internal details", async () => {
    failRender = true;
    const response = await request("GET", "/", true);
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body).error).toBe("Internal server error");
    expect(response.body).not.toContain("private implementation detail");
    failRender = false;
    expect(await request("GET", "/", true)).toEqual({ status: 200, body: "healthy" });
  });
});
