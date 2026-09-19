import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface McpOAuthOptions { clientId?: string; clientSecret?: string; scope?: string; callbackPort?: number }
interface Credentials { client?: OAuthClientInformationMixed; tokens?: OAuthTokens }

/** Per-server credentials; PKCE verifiers and callback state stay in memory. */
export class McpOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  private credentials: Credentials = {};
  private readonly file: string;
  private readonly ready: Promise<void>;
  private verifier?: string;
  private nonce = randomBytes(32).toString("hex");
  private server?: Server;
  private pending?: Promise<string>;
  private rejectPending?: (error: Error) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private saving = Promise.resolve();

  constructor(url: string, private options: McpOAuthOptions = {}, directory = process.env.PHREN_MCP_AUTH_DIR ?? path.join(homedir(), ".phren", "agent", "mcp-auth")) {
    const port = options.callbackPort ?? 14557;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid MCP OAuth callback port");
    this.redirectUrl = `http://127.0.0.1:${port}/callback`;
    this.clientMetadata = { client_name: "phren-agent", redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: options.clientSecret ? "client_secret_post" : "none", ...(options.scope ? { scope: options.scope } : {}) };
    const key = createHash("sha256").update(`${new URL(url).href}\n${options.clientId ?? ""}\n${this.redirectUrl}`).digest("hex");
    this.file = path.join(directory, `${key}.json`);
    this.ready = readFile(this.file, "utf8").then(raw => {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === "object") this.credentials = saved;
    }).catch(() => {});
  }
  state() { return this.nonce; }
  async clientInformation() {
    await this.ready;
    return this.options.clientId ? { client_id: this.options.clientId, ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}) } : this.credentials.client;
  }
  async saveClientInformation(client: OAuthClientInformationMixed) { await this.ready; this.credentials.client = client; await this.save(); }
  async tokens() { await this.ready; return this.credentials.tokens; }
  async saveTokens(tokens: OAuthTokens) { await this.ready; this.credentials.tokens = tokens; await this.save(); }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { if (!this.verifier) throw new Error("Missing MCP OAuth PKCE verifier"); return this.verifier; }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    await this.ready;
    if (scope === "all" || scope === "client") delete this.credentials.client;
    if (scope === "all" || scope === "tokens") delete this.credentials.tokens;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    await this.save();
  }
  private save() {
    const raw = JSON.stringify(this.credentials);
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomBytes(8).toString("hex")}`;
      await writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.file);
    });
    return this.saving;
  }
  async redirectToAuthorization(url: URL) {
    if (this.pending) throw new Error("MCP authorization is already pending");
    this.pending = new Promise<string>((resolve, reject) => {
      this.rejectPending = reject;
      this.server = createServer((request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        const callback = new URL(request.url ?? "/", this.redirectUrl);
        if (request.method !== "GET" || callback.pathname !== "/callback" || callback.searchParams.get("state") !== this.nonce) {
          response.writeHead(400); response.end("Invalid authorization callback."); return;
        }
        const code = callback.searchParams.get("code");
        if (callback.searchParams.has("error") || !code) {
          response.writeHead(400); response.end("Authorization was not completed.");
          reject(new Error("MCP authorization was denied"));
        } else { response.end("Authorization received. You can return to phren-agent."); resolve(code); }
        this.closeListener();
      });
      this.server.once("error", reject);
      this.timer = setTimeout(() => { reject(new Error("MCP authorization timed out after 5 minutes")); this.closeListener(); }, 300_000);
    });
    this.pending.catch(() => {});
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(Number(new URL(this.redirectUrl).port), "127.0.0.1", resolve);
    });
    process.stderr.write(`Authorize MCP access in your browser:\n${url.href}\n`);
  }
  async authorizationCode(): Promise<string> {
    if (!this.pending) throw new Error("MCP server requires authorization; enable oauth in its configuration");
    try { return await this.pending; }
    finally { this.pending = undefined; this.rejectPending = undefined; this.closeListener(); this.nonce = randomBytes(32).toString("hex"); }
  }
  private closeListener() { if (this.timer) clearTimeout(this.timer); this.server?.close(); this.server = undefined; }
  close() { this.rejectPending?.(new Error("MCP connection closed")); this.closeListener(); }
}
