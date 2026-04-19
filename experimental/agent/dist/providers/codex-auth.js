/**
 * Codex OAuth PKCE flow — authenticate with your ChatGPT subscription.
 * Same flow as Codex CLI, no middleman.
 */
import * as crypto from "crypto";
import * as http from "http";
import { authProfilesPath, getCodexAuthProfile, hasCodexAuthProfile, hasCodexCliAuth, removeCodexAuthProfile, upsertCodexAuthProfile, } from "@phren/cli/auth/profiles";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const CALLBACK_PORT = 1455;
const SCOPES = "openid profile email offline_access";
function parseAccountId(accessToken) {
    try {
        const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString());
        return payload.sub || payload.account_id;
    }
    catch {
        return undefined;
    }
}
function generatePKCE() {
    const bytes = crypto.randomBytes(32);
    const codeVerifier = bytes.toString("base64url");
    const hash = crypto.createHash("sha256").update(codeVerifier).digest();
    const codeChallenge = hash.toString("base64url");
    return { codeVerifier, codeChallenge };
}
function buildAuthUrl(codeChallenge, state) {
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
async function exchangeCode(code, codeVerifier) {
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
    const data = await res.json();
    const expiresIn = data.expires_in || 3600;
    const accessToken = data.access_token;
    const accountId = parseAccountId(accessToken);
    return {
        access_token: accessToken,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + expiresIn * 1000,
        account_id: accountId,
    };
}
async function refreshToken(refreshTok, existingAccountId) {
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
    const data = await res.json();
    const expiresIn = data.expires_in || 3600;
    const accessToken = data.access_token;
    return {
        access_token: accessToken,
        refresh_token: data.refresh_token || refreshTok,
        expires_at: Date.now() + expiresIn * 1000,
        account_id: parseAccountId(accessToken) ?? existingAccountId,
    };
}
/** Interactive OAuth login — opens browser, waits for callback. */
export async function codexLogin() {
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
    }
    catch {
        // Browser open failed — user has the URL printed above
    }
    // Start local callback server
    const code = await new Promise((resolve, reject) => {
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
            resolve(returnedCode);
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
    upsertCodexAuthProfile({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_at,
        accountId: tokens.account_id,
        lastRefresh: new Date().toISOString(),
        source: "phren-oauth",
    });
    console.log(`Logged in! Token saved to ${authProfilesPath()}`);
}
// Lock so concurrent callers share a single in-flight refresh
let refreshPromise = null;
/** Load stored token, auto-refresh if expiring within 5 minutes. */
export async function getAccessToken() {
    let profile = getCodexAuthProfile({ allowCliImport: true });
    if (!profile) {
        throw new Error("Not logged in to Codex. Run: phren-agent auth login");
    }
    // Refresh if expiring within 5 minutes
    if (profile.expiresAt < Date.now() + 5 * 60 * 1000) {
        if (!profile.refreshToken) {
            throw new Error("Token expired and no refresh token. Run: phren-agent auth login");
        }
        if (!refreshPromise) {
            console.error("Refreshing Codex token...");
            refreshPromise = refreshToken(profile.refreshToken, profile.accountId).finally(() => { refreshPromise = null; });
        }
        const refreshed = await refreshPromise;
        profile = upsertCodexAuthProfile({
            accessToken: refreshed.access_token,
            refreshToken: refreshed.refresh_token,
            expiresAt: refreshed.expires_at,
            accountId: refreshed.account_id ?? profile.accountId,
            lastRefresh: new Date().toISOString(),
            source: "phren-oauth",
        });
    }
    return { accessToken: profile.accessToken, accountId: profile.accountId };
}
/** Check if user has a stored Codex token. */
export function hasCodexToken() {
    return hasCodexAuthProfile({ allowCliImport: true });
}
/** Remove stored token. */
export function codexLogout() {
    const removed = removeCodexAuthProfile();
    if (!removed) {
        console.log("No local Phren Codex profile found.");
    }
    else {
        console.log("Logged out of Codex in Phren.");
    }
    if (hasCodexCliAuth()) {
        console.log("Codex CLI auth at ~/.codex/auth.json was left untouched.");
    }
}
