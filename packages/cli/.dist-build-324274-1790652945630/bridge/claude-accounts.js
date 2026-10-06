// Claude accounts on this computer: one Claude config home per account.
// ~/.claude is the "default" account and is launched without CLAUDE_CONFIG_DIR,
// so its keychain item and ~/.claude.json stay where Claude Code put them.
// Every ~/.claude-<slug> holding a .claude.json is another account. See docs/accounts.md.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { dump, load } from "js-yaml";
import { claudeConfigDir, homeDir } from "../home-paths.js";
import { atomic, bridgeRoot } from "./protocol.js";
export const DEFAULT_ACCOUNT = "default";
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export function isAccountSlug(value) { return value === DEFAULT_ACCOUNT || SLUG.test(value); }
function defaultHome(env) {
    const configured = Boolean(env.CLAUDE_CONFIG_DIR?.trim());
    const dir = claudeConfigDir(env);
    // Claude keeps .claude.json inside CLAUDE_CONFIG_DIR when set, else beside ~/.claude.
    return { id: DEFAULT_ACCOUNT, dir, configFile: path.join(configured ? dir : homeDir(env), ".claude.json"), isDefault: true };
}
/** Every Claude home on this computer, default first, then by slug. */
export function claudeHomes(env = process.env) {
    const homes = [defaultHome(env)];
    const home = homeDir(env);
    let names = [];
    try {
        names = readdirSync(home);
    }
    catch {
        return homes;
    }
    for (const name of names.sort()) {
        if (!name.startsWith(".claude-"))
            continue;
        const id = name.slice(".claude-".length);
        if (!SLUG.test(id) || id === DEFAULT_ACCOUNT)
            continue;
        const dir = path.join(home, name);
        if (dir === homes[0].dir)
            continue;
        try {
            if (!statSync(dir).isDirectory() || !existsSync(path.join(dir, ".claude.json")))
                continue;
        }
        catch {
            continue;
        }
        homes.push({ id, dir, configFile: path.join(dir, ".claude.json"), isDefault: false });
    }
    return homes;
}
export function claudeHome(id, env = process.env) {
    const wanted = id?.trim() || DEFAULT_ACCOUNT;
    return claudeHomes(env).find(home => home.id === wanted);
}
/** The home a transcript or other file lives in, by longest matching directory. */
export function claudeHomeOfPath(file, env = process.env) {
    const resolved = path.resolve(file);
    return claudeHomes(env)
        .filter(home => resolved.startsWith(home.dir + path.sep))
        .sort((a, b) => b.dir.length - a.dir.length)[0];
}
/** Environment a launch into this home needs; empty for the default home. */
export function claudeLaunchEnv(home) {
    return home.isDefault ? {} : { CLAUDE_CONFIG_DIR: home.dir };
}
/** The config home a running Claude process uses, from its CLAUDE_CONFIG_DIR. */
export function claudeHomeOfEnv(value, env = process.env) {
    if (!value?.trim())
        return claudeHome(DEFAULT_ACCOUNT, env);
    const dir = path.resolve(value.trim());
    return claudeHomes(env).find(home => home.dir === dir);
}
// ── labels (<bridge>/accounts.yaml) ─────────────────────────────────────────
export const accountsFile = () => path.join(bridgeRoot(), "accounts.yaml");
function readLabels() {
    try {
        const parsed = load(readFileSync(accountsFile(), "utf8"));
        const claude = parsed && typeof parsed === "object" ? parsed.claude : undefined;
        if (!claude || typeof claude !== "object")
            return {};
        return Object.fromEntries(Object.entries(claude)
            .filter(([id, label]) => isAccountSlug(id) && typeof label === "string" && label.trim().length > 0 && label.length <= 40)
            .map(([id, label]) => [id, label.trim()]));
    }
    catch {
        return {};
    }
}
export function accountLabel(id, labels = readLabels()) {
    if (labels[id])
        return labels[id];
    if (id === DEFAULT_ACCOUNT)
        return "Claude";
    return id.split("-").filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
export async function setAccountLabel(id, label) {
    if (!isAccountSlug(id))
        throw new Error(`"${id}" is not an account name: use lowercase letters, digits and dashes.`);
    const clean = label.trim();
    if (!clean || clean.length > 40 || /[\u0000-\u001f]/.test(clean))
        throw new Error("A label is 1 to 40 printable characters.");
    let parsed = {};
    try {
        const raw = load(await readFile(accountsFile(), "utf8"));
        if (raw && typeof raw === "object")
            parsed = raw;
    }
    catch { /* First label. */ }
    const claude = parsed.claude && typeof parsed.claude === "object" ? parsed.claude : {};
    parsed.claude = { ...claude, [id]: clean };
    await mkdir(bridgeRoot(), { recursive: true, mode: 0o700 });
    await atomic(accountsFile(), dump(parsed), 0o600);
}
// ── identity (.claude.json oauthAccount, no tokens) ─────────────────────────
const identityCache = new Map();
function oauthIdentity(configFile) {
    try {
        const stat = statSync(configFile);
        if (!stat.isFile() || stat.size > 16_777_216)
            return {};
        const cached = identityCache.get(configFile);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
            return cached;
        const config = JSON.parse(readFileSync(configFile, "utf8"));
        const account = config.oauthAccount && typeof config.oauthAccount === "object" ? config.oauthAccount : {};
        const uuid = typeof account.accountUuid === "string" && account.accountUuid ? account.accountUuid : undefined;
        const value = { mtimeMs: stat.mtimeMs, size: stat.size, uuid };
        identityCache.set(configFile, value);
        return value;
    }
    catch {
        return {};
    }
}
/** Stable across computers for one subscription; home-scoped when unknown. */
export function claudeAccountKey(home) {
    const { uuid } = oauthIdentity(home.configFile);
    return uuid ? "claude:" + createHash("sha256").update(uuid).digest("hex").slice(0, 12) : `claude:home:${home.id}`;
}
export function claudeAccountRef(home, labels = readLabels()) {
    return { id: home.id, label: accountLabel(home.id, labels), key: claudeAccountKey(home) };
}
export const CODEX_ACCOUNT = { id: DEFAULT_ACCOUNT, label: "Codex", key: "codex" };
/** Only for tests. */
export function clearAccountCaches() { identityCache.clear(); authCache.clear(); }
const AUTH_CACHE_MS = 5 * 60_000;
const AUTH_TIMEOUT_MS = 10_000;
const SIGNED_OUT_CACHE_MS = 30_000;
const authCache = new Map();
/** Parse `claude auth status --json`. Never keeps anything but the state and plan. */
export function parseAuthStatus(output) {
    try {
        const value = JSON.parse(output);
        if (value.loggedIn !== true)
            return { signedIn: false, reason: "Not signed in" };
        const plan = typeof value.subscriptionType === "string" && /^[a-z0-9_-]{1,32}$/i.test(value.subscriptionType) ? value.subscriptionType : undefined;
        return { signedIn: true, ...(plan ? { plan } : {}) };
    }
    catch {
        return { signedIn: false, unknown: true, reason: "Claude did not report its sign-in state" };
    }
}
const runAuthStatus = home => new Promise(resolve => {
    let out = "", done = false;
    const child = spawn("claude", ["auth", "status", "--json"], {
        cwd: homeDir(), stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...claudeLaunchEnv(home), NO_COLOR: "1" },
    });
    const finish = () => { if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(out);
    } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(); }, AUTH_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { if (out.length < 16_384)
        out += chunk.toString(); });
    child.on("error", finish);
    child.on("close", finish);
});
export function claudeAuthStatus(home, run = runAuthStatus, now = Date.now()) {
    const cached = authCache.get(home.dir);
    if (cached && now - cached.at < (cached.signedIn === false ? SIGNED_OUT_CACHE_MS : AUTH_CACHE_MS))
        return cached.value;
    const entry = { at: now, value: Promise.resolve({ signedIn: false }) };
    // A signed-out answer is kept briefly so a fresh /login shows up within half a minute.
    entry.value = run(home).then(parseAuthStatus, () => ({ signedIn: false, unknown: true, reason: "Claude did not report its sign-in state" }))
        .then(status => { entry.signedIn = status.unknown ? false : status.signedIn; return status; });
    authCache.set(home.dir, entry);
    return entry.value;
}
