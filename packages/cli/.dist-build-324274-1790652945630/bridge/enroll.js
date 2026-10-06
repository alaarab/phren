import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { readdir, readFile, stat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { BridgeError } from "./protocol.js";
import { herdrRoot } from "./herdr.js";
import { phrenStoreRoot } from "./transcripts.js";
import { addProjectFromPath } from "../core/project.js";
import { getProjectOwnershipDefault, readProjectConfig } from "../project-config.js";
import { projectSlugFromPath } from "../phren-paths.js";
import { runBestEffortGit } from "../cli/session-git.js";
import { mergeStoreUpstream } from "../sync/store-merge.js";
import { countGit } from "./metrics.js";
import { storeCommitMessage } from "../machine-identity.js";
const exec = promisify(execFile);
const runEnrollStoreGit = async (cwd, args) => {
    const result = await runBestEffortGit(args, cwd);
    return { ok: result.ok, output: result.output ?? "", error: result.error };
};
const SEARCH_ROOTS = ["Sites", "Projects", "projects", "Code", "code", "dev", "src", "repos", "workspace"];
/** GitHub-style URLs only: https, or the ssh shorthand. No local paths, no
 * `ext::` or other transports git would happily run. */
const CLONE_URL = /^(?:https:\/\/[a-z0-9.-]+\/[\w.-]+\/[\w.-]+?|git@[a-z0-9.-]+:[\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i;
function repoName(url) {
    const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
    return last.replace(/\.git$/i, "");
}
async function isRepository(directory) {
    // `.git` is a folder for a checkout and a file for a worktree.
    try {
        await stat(path.join(directory, ".git"));
        return true;
    }
    catch {
        return false;
    }
}
/** Every store project's registered source folder (real path), and the names
 * themselves, so a candidate can be marked as already tracked. */
async function registeredSources(env) {
    const store = phrenStoreRoot(env);
    const paths = new Set(), names = new Set();
    let entries = [];
    try {
        entries = (await readdir(store, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => e.name);
    }
    catch {
        return { paths, names };
    }
    for (const project of entries) {
        names.add(project);
        const source = readProjectConfig(store, project).sourcePath;
        if (typeof source === "string" && source) {
            try {
                paths.add(realpathSync.native(path.resolve(source)));
            }
            catch { /* not on this computer */ }
        }
    }
    return { paths, names };
}
/** Git checkouts on this computer, newest activity first, then Herdr's
 * saved workspaces, then one level under the usual project roots. */
export async function candidateRepos(activity, env = process.env) {
    const registered = await registeredSources(env);
    const found = [];
    const seen = new Set();
    const offer = async (directory, source, lastSeen) => {
        let dir = path.resolve(directory);
        try {
            if (!(await stat(dir)).isDirectory())
                return;
            dir = realpathSync.native(dir);
        }
        catch {
            return;
        }
        if (seen.has(dir) || !(await isRepository(dir)))
            return;
        seen.add(dir);
        const name = projectSlugFromPath(dir);
        found.push({ directory: dir, name, source, registered: registered.paths.has(dir) || registered.names.has(name), ...(lastSeen ? { lastSeen } : {}) });
    };
    // Where sessions ran: walk up to the repository root so a subfolder session
    // still offers the checkout itself.
    const toplevel = async (directory) => {
        // A session folder may be gone (a worktree, a temp checkout); its nearest
        // surviving parent still says which repository it was in.
        let existing = directory;
        while (!(await stat(existing).catch(() => undefined))) {
            const parent = path.dirname(existing);
            if (parent === existing)
                return undefined;
            existing = parent;
        }
        try {
            countGit("enroll");
            return (await exec("git", ["-C", existing, "rev-parse", "--show-toplevel"], { env: nonInteractiveGitEnv(), timeout: 5_000 })).stdout.trim() || undefined;
        }
        catch {
            return undefined;
        }
    };
    for (const event of [...activity].reverse()) {
        const directory = typeof event.directory === "string" ? event.directory : undefined;
        if (!directory || !path.isAbsolute(directory))
            continue;
        const root = await toplevel(directory);
        if (root)
            await offer(root, "activity", typeof event.at === "string" ? event.at : undefined);
    }
    try {
        const session = JSON.parse(await readFile(path.join(herdrRoot(), "session.json"), "utf8"));
        for (const match of JSON.stringify(session).matchAll(/"cwd":\s*"((?:\\.|[^"\\])*)"/g)) {
            const directory = JSON.parse(`"${match[1]}"`);
            if (!path.isAbsolute(directory))
                continue;
            const root = await toplevel(directory);
            if (root)
                await offer(root, "herdr");
        }
    }
    catch { /* no saved session */ }
    const home = homedir();
    for (const root of [...(env.PROJECTS_DIR ? [env.PROJECTS_DIR] : []), ...SEARCH_ROOTS.map(r => path.join(home, r))]) {
        let children = [];
        try {
            children = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => path.join(root, e.name));
        }
        catch {
            continue;
        }
        for (const child of children.slice(0, 200))
            await offer(child, "search");
    }
    return found.slice(0, 64);
}
/** The folder new clones land in: `$PROJECTS_DIR`, else the first of the
 * usual roots that exists, else `~/Projects` (created). */
async function cloneRoot(env) {
    const home = homedir();
    for (const root of [...(env.PROJECTS_DIR ? [env.PROJECTS_DIR] : []), ...SEARCH_ROOTS.filter(r => r !== "Sites").map(r => path.join(home, r))]) {
        try {
            if ((await stat(root)).isDirectory())
                return root;
        }
        catch { /* next */ }
    }
    const fallback = path.join(home, "Projects");
    await mkdir(fallback, { recursive: true });
    return fallback;
}
/** Commit the store and push it when a remote exists, so the phone can pull
 * the new project. Best effort: enrollment already succeeded. */
async function publishStore(store, project) {
    const status = await runBestEffortGit(["status", "--porcelain"], store);
    if (!status.ok)
        return { store: "error", storeDetail: status.error };
    if (!status.output)
        return { store: "unchanged" };
    const add = await runBestEffortGit(["add", "--sparse", "-A"], store);
    // The same belt-and-suspenders unstage as the Stop hook's auto-save.
    if (add.ok)
        await runBestEffortGit(["reset", "HEAD", "--", ".env", "**/.env", "*.pem", "*.key", ".config/auth-profiles.json"], store);
    const commit = add.ok ? await runBestEffortGit(["commit", "-m", storeCommitMessage(`Add project ${project} from iPhone`)], store) : add;
    if (!commit.ok)
        return { store: "error", storeDetail: commit.error };
    const remotes = await runBestEffortGit(["remote"], store);
    if (!remotes.ok || !remotes.output)
        return { store: "committed", storeDetail: "no remote configured" };
    const pull = await mergeStoreUpstream(store, { git: runEnrollStoreGit, commitLocalWrites: false });
    if (pull.status !== "updated" && pull.status !== "unchanged")
        return { store: "committed", storeDetail: pull.detail };
    const push = await runBestEffortGit(["push"], store);
    return push.ok ? { store: "pushed" } : { store: "committed", storeDetail: push.error };
}
export async function enrollProject(input, env = process.env) {
    const store = phrenStoreRoot(env);
    try {
        if (!(await stat(path.join(store, ".config"))).isDirectory())
            throw new Error();
    }
    catch {
        throw new BridgeError(409, "phren is not set up on this computer. Run phren init there.");
    }
    let directory;
    let cloned = false;
    if (typeof input.cloneUrl === "string" && input.cloneUrl) {
        const url = input.cloneUrl.trim();
        if (url.length > 512 || !CLONE_URL.test(url))
            throw new BridgeError(400, "Enter a GitHub repository URL (https://github.com/owner/repo).");
        const name = repoName(url);
        if (!name || name === "." || name === "..")
            throw new BridgeError(400, "That URL has no repository name.");
        directory = path.join(await cloneRoot(env), name);
        try {
            await stat(directory);
            throw new BridgeError(409, `${directory} already exists on this computer. Add that folder instead.`);
        }
        catch (error) {
            if (error instanceof BridgeError)
                throw error;
        }
        try {
            countGit("enroll");
            await exec("git", ["clone", "--", url, directory], { timeout: 180_000, maxBuffer: 4_194_304, env: nonInteractiveGitEnv(env) });
        }
        catch (error) {
            const detail = error instanceof Error && "stderr" in error ? String(error.stderr ?? "").trim().split("\n").pop() : undefined;
            throw new BridgeError(502, `git clone failed${detail ? `: ${detail}` : ""}.`);
        }
        cloned = true;
    }
    else if (typeof input.directory === "string" && input.directory) {
        const raw = input.directory;
        if (raw.length > 4096 || raw.includes("\0") || !path.isAbsolute(raw))
            throw new BridgeError(400, "Enter the full folder path on this computer.");
        try {
            directory = realpathSync.native(raw);
            if (!(await stat(directory)).isDirectory())
                throw new Error();
        }
        catch {
            throw new BridgeError(404, "That folder is not on this computer.");
        }
    }
    else
        throw new BridgeError(400, "Choose a folder or a repository URL.");
    const added = addProjectFromPath(store, directory, env.PHREN_PROFILE || undefined, getProjectOwnershipDefault(store));
    if (!added.ok)
        throw new BridgeError(409, added.error);
    return { ok: true, project: added.data.project, directory, cloned, ...(await publishStore(store, added.data.project)) };
}
