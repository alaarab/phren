import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { connectMcpServers, mcpRegistry } from "../mcp-client.js";

const servers: Server[] = [];
const cleanups: (() => void)[] = [];
let credentials: string | undefined;
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterEach(async () => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (credentials) await rm(credentials, { recursive: true, force: true });
});

const tools = [{ name: "hello", inputSchema: { type: "object" } }];
const resultFor = (method: string) => method === "initialize"
  ? { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1" } }
  : method === "tools/list" ? { tools }
  : method === "resources/list" ? { resources: [{ uri: "fixture://readme", name: "Readme" }] }
  : { content: [{ type: "text", text: "tool failed" }], isError: true };

it("receives accepted requests on a separate SSE stream and propagates tool errors", async () => {
  let stream: ServerResponse | undefined;
  const queued: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": ready\n\n");
      stream = response; queued.splice(0).forEach(message => response.write(message)); return;
    }
    let body = ""; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.method === "initialize") {
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: resultFor(message.method) })); return;
    }
    response.writeHead(202); response.end();
    if (message.id !== undefined) {
      const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: resultFor(message.method) })}\n\n`;
      if (stream) stream.write(event); else queued.push(event);
    }
  });
  const url = await listen(server);
  const connection = await connectMcpServers({ separate: { url } }); cleanups.push(connection.cleanup);
  expect(connection.tools).toHaveLength(1);
  expect(await connection.tools[0].execute({})).toMatchObject({ is_error: true, output: "tool failed" });
  expect(await mcpRegistry.listResources("separate")).toMatchObject([{ uri: "fixture://readme", server: "separate" }]);
});

it("completes OAuth discovery, PKCE callback and token exchange, then reuses private credentials", async () => {
  credentials = await mkdtemp(path.join(tmpdir(), "phren-mcp-auth-"));
  vi.stubEnv("PHREN_MCP_AUTH_DIR", credentials);
  // Reserve a free loopback port, then release it for the OAuth callback listener.
  const probe = createServer(); const probeUrl = await listen(probe);
  const callbackPort = Number(new URL(probeUrl).port);
  await new Promise<void>(resolve => probe.close(() => resolve()));
  servers.splice(servers.indexOf(probe), 1);
  let origin = "", challenge = "", exchanges = 0, registrations = 0, authorizations = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const route = new URL(request.url!, origin).pathname;
    const json = (value: unknown) => response.end(JSON.stringify(value));
    if (route.startsWith("/.well-known/oauth-protected-resource")) return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (route === "/.well-known/oauth-authorization-server") return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (route === "/register") { registrations++; return json({ client_id: "fixture-client", redirect_uris: [`http://127.0.0.1:${callbackPort}/callback`] }); }
    let body = ""; for await (const chunk of request) body += chunk;
    if (route === "/token") {
      const parameters = new URLSearchParams(body);
      expect(parameters.get("resource")).toBe(`${origin}/mcp`);
      expect(createHash("sha256").update(parameters.get("code_verifier")!).digest("base64url")).toBe(challenge);
      exchanges++; return json({ access_token: "fixture-access", token_type: "Bearer", refresh_token: "fixture-refresh", expires_in: 3600 });
    }
    if (request.headers.authorization !== "Bearer fixture-access") {
      response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }); return json({});
    }
    if (request.method === "GET") { response.writeHead(405); response.end(); return; }
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202); response.end(); return; }
    json({ jsonrpc: "2.0", id: message.id, result: resultFor(message.method) });
  });
  origin = await listen(server);
  const callbacks: Promise<void>[] = [];
  const logs: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((text: string) => {
    logs.push(String(text));
    const link = String(text).match(/http:\/\/127\.0\.0\.1:\d+\/authorize\?[^\n]+/);
    if (link) {
      authorizations++;
      const url = new URL(link[0]); challenge = url.searchParams.get("code_challenge")!;
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callbacks.push((async () => {
        callback.searchParams.set("code", "fixture-code"); callback.searchParams.set("state", "wrong");
        expect((await fetch(callback)).status).toBe(400);
        callback.searchParams.set("state", url.searchParams.get("state")!);
        expect((await fetch(callback)).status).toBe(200);
      })());
    }
    return true;
  }) as typeof process.stderr.write);
  const config = { secured: { url: `${origin}/mcp`, oauth: { callbackPort } } };
  const first = await connectMcpServers(config); cleanups.push(first.cleanup);
  expect(first.tools, logs.join("\n")).toHaveLength(1); await Promise.all(callbacks);
  first.cleanup();
  const second = await connectMcpServers(config); cleanups.push(second.cleanup);
  expect(second.tools).toHaveLength(1);
  expect([registrations, authorizations, exchanges]).toEqual([1, 1, 1]);
  const files = await readdir(credentials);
  expect(files).toHaveLength(1);
  expect((await stat(path.join(credentials, files[0]))).mode & 0o777).toBe(0o600);
  expect(await readFile(path.join(credentials, files[0]), "utf8")).not.toContain("code_verifier");
});
