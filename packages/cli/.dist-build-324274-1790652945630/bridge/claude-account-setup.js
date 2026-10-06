// `phren bridge accounts add`: a new Claude home that shares the default home's setup.
import { chmod, lstat, mkdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { homeDir } from "../home-paths.js";
import { claudeHome, claudeHomes, DEFAULT_ACCOUNT, isAccountSlug, setAccountLabel } from "./claude-accounts.js";
import { atomic } from "./protocol.js";
/** Entries of the default home every account shares by symlink. */
export const SHARED_ENTRIES = ["settings.json", "CLAUDE.md", "skills", "agents", "commands", "plugins"];
const exists = (file) => lstat(file).then(() => true, () => false);
async function readObject(file) {
    try {
        const value = JSON.parse(await readFile(file, "utf8"));
        return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
async function mcpServersOf(file) {
    const servers = (await readObject(file))?.mcpServers;
    return servers && typeof servers === "object" && !Array.isArray(servers) ? servers : {};
}
/** Write the default home's user-scope mcpServers into one home's .claude.json; the default's entries win by name. */
async function mergeMcpServers(file, servers) {
    const present = await exists(file);
    const existing = present ? await readObject(file) : {};
    if (!existing)
        return false; // Unreadable or not an object: leave the owner's file alone.
    const current = existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers) ? existing.mcpServers : {};
    const merged = { ...current, ...servers };
    if (present && JSON.stringify(merged) === JSON.stringify(current))
        return false;
    await atomic(file, JSON.stringify({ ...existing, mcpServers: merged }, null, 2) + "\n", 0o600);
    return true;
}
/** Refresh every extra home's mcpServers from the default home. Returns the ids that changed. */
export async function syncAccountMcpServers(env = process.env) {
    const homes = claudeHomes(env);
    const servers = await mcpServersOf(homes[0].configFile);
    const changed = [];
    for (const home of homes.slice(1))
        if (await mergeMcpServers(home.configFile, servers))
            changed.push(home.id);
    return changed;
}
export async function addClaudeAccount(slug, opts = {}) {
    const env = opts.env ?? process.env;
    if (slug === DEFAULT_ACCOUNT || !isAccountSlug(slug))
        throw new Error(`"${slug}" is not an account name: use 1 to 32 lowercase letters, digits and dashes, and not "default".`);
    const source = claudeHome(DEFAULT_ACCOUNT, env);
    const dir = path.join(homeDir(env), `.claude-${slug}`);
    if (dir === source.dir)
        throw new Error(`~/.claude-${slug} is the default Claude home.`);
    const created = !(await exists(dir));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700); // An existing home keeps its login: tighten it too.
    const linked = [];
    for (const name of SHARED_ENTRIES) {
        const target = path.join(source.dir, name), link = path.join(dir, name);
        if (!(await exists(target)) || await exists(link))
            continue;
        await symlink(target, link);
        linked.push(name);
    }
    await mergeMcpServers(path.join(dir, ".claude.json"), await mcpServersOf(source.configFile));
    if (opts.label)
        await setAccountLabel(slug, opts.label);
    return { id: slug, dir, linked, created };
}
