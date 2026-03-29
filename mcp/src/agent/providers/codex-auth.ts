/**
 * Codex OAuth PKCE flow — authenticate with your ChatGPT subscription.
 * Same flow as Codex CLI, no middleman.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as os from "os";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const CALLBACK_PORT = 1455;
const SCOPES = "openid profile email offline_access";

interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
  account_id?: string;
}

function tokenPath(): string {
  const dir = path.join(os.homedir(), ".phren-agent");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "codex-token.json");
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const bytes = crypto.randomBytes(32);
  const codeVerifier = bytes.toString("base64url");
  const hash = crypto.createHash("sha256").update(codeVerifier).digest();
  const codeChallenge = hash.toString("base64url");
  return { codeVerifier, codeChallenge };
}

function buildAuthUrl(codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const expiresIn = (data.expires_in as number) || 3600;

  // Extract account_id from JWT access token
  let accountId: string | undefined;
  try {
    const payload = JSON.parse(Buffer.from((data.access_token as string).split(".")[1], "base64url").toString());
    accountId = payload.sub || payload.account_id;
  } catch { /* skip */ }

  return {
    access_token: data.access_token as string,
    refresh_token: data.refresh_token as string | undefined,
    expires_at: Date.now() + expiresIn * 1000,
    account_id: accountId,
  };
}

async function refreshToken(refreshTok: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshTok,
      client_id: CLIENT_ID,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const expiresIn = (data.expires_in as number) || 3600;

  return {
    access_token: data.access_token as string,
    refresh_token: (data.refresh_token as string) || refreshTok,
    expires_at: Date.now() + expiresIn * 1000,
  };
}

/** Interactive OAuth login — opens browser, waits for callback. */
export async function codexLogin(): Promise<void> {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = buildAuthUrl(codeChallenge, state);

  console.log("Opening browser for Codex login...");
  console.log(`If it doesn't open, visit:\n${authUrl}\n`);

  // Open browser
  const openCmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  try {
    const { execFileSync } = await import("child_process");
    execFileSync(openCmd, [authUrl], { stdio: "ignore" });
  } catch {
    // Browser open failed — user has the URL printed above
  }

  // Start local callback server
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<h2>Login failed: ${error}</h2><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h2>State mismatch — try again</h2>");
        // Don't crash — just ignore stale callbacks and keep waiting
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>Login successful!</h2><p>You can close this tab and return to the terminal.</p>");
      server.close();
      resolve(returnedCode!);
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`Waiting for callback on port ${CALLBACK_PORT}...`);
    });

    server.on("error", (err) => {
      reject(new Error(`Callback server failed: ${err.message}. Is port ${CALLBACK_PORT} in use?`));
    });

    // Timeout after 2 minutes
    setTimeout(() => { server.close(); reject(new Error("Login timed out (2 min)")); }, 120_000);
  });

  // Exchange code for tokens
  console.log("Exchanging code for tokens...");
  const tokens = await exchangeCode(code, codeVerifier);

  // Save tokens
  fs.writeFileSync(tokenPath(), JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
  console.log(`Logged in! Token saved to ${tokenPath()}`);
}

/** Load stored token, auto-refresh if expiring within 5 minutes. */
export async function getAccessToken(): Promise<{ accessToken: string; accountId?: string }> {
  const file = tokenPath();
  if (!fs.existsSync(file)) {
    throw new Error("Not logged in to Codex. Run: phren-agent auth login");
  }

  let tokens: TokenSet = JSON.parse(fs.readFileSync(file, "utf-8"));

  // Refresh if expiring within 5 minutes
  if (tokens.expires_at < Date.now() + 5 * 60 * 1000) {
    if (!tokens.refresh_token) {
      throw new Error("Token expired and no refresh token. Run: phren-agent auth login");
    }
    console.error("Refreshing Codex token...");
    tokens = await refreshToken(tokens.refresh_token);
    fs.writeFileSync(file, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
  }

  return { accessToken: tokens.access_token, accountId: tokens.account_id };
}

/** Check if user has a stored Codex token. */
export function hasCodexToken(): boolean {
  return fs.existsSync(tokenPath());
}

/** Remove stored token. */
export function codexLogout(): void {
  const file = tokenPath();
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log("Logged out of Codex.");
  } else {
    console.log("Not logged in.");
  }
}
