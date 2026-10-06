import { rm } from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAllStores } from "../store-registry.js";
import { git } from "./projects.js";
import { z } from "zod";
import { getProjectDirs } from "../shared.js";
import { codePackageHint, loadCodePackage } from "../modules/code-package.js";
const indexProject = async (store, ...args) => (await requireCodePackage(store)).indexProject(store, ...args);
import { isValidProjectName } from "../utils-paths.js";
import { errorMessage } from "../utils.js";
import { logger } from "../logger.js";
import { BridgeError, bridgeRoot } from "./protocol.js";
export async function requireCodePackage(store) {
    const code = await loadCodePackage(store);
    if (!code)
        throw new BridgeError(503, codePackageHint(store));
    return code;
}
/** Resolve only registered stores. Phone IDs are repository names; no client
 * path can select a filesystem location. Omitting the ID supports older phones. */
export async function resolveCodeStore(base, value, write = false) {
    if (!value)
        return base;
    const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?$/).parse(value);
    const stores = resolveAllStores(base).filter(store => store.available !== false);
    const matches = [];
    for (const store of stores) {
        const remote = store.remote ?? (await git(store.path, "config", "--get", "remote.origin.url").catch(() => "")).trim();
        const repo = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1];
        if (id === store.id || id === store.name || id.toLowerCase() === repo?.toLowerCase())
            matches.push(store);
    }
    if (matches.length !== 1)
        throw new BridgeError(404, "That store is not uniquely registered on this computer.");
    if (write && matches[0].role === "readonly")
        throw new BridgeError(403, "That store is read-only.");
    return matches[0].path;
}
/**
 * Read routes over the `code` module's local symbol index (stage 3).
 *
 * The phone's Code screen calls these over the Hook's HTTP pipe; each one is a
 * thin JSON formatter over `code/query.ts`, so the CLI, the MCP tools and the
 * phone all read the same index the same way. A project with no index is a 404
 * with the command that builds one. `CodeReindexer` follows the git module's
 * recorded change events and re-indexes the affected project after a short
 * debounce; a branch switch (HEAD changed) forces a full re-index.
 */
const KIND_VALUES = ["function", "method", "class", "struct", "enum", "interface", "type", "variable", "types"];
const projectSchema = z.string().min(1).max(100).refine(value => isValidProjectName(value), "Choose a valid project name.");
const querySchema = z.string().max(500);
const symbolSchema = z.string().min(1).max(4600);
const pathSchema = z.string().min(1).max(4096).refine(value => !value.includes("\0") && !value.split("/").includes(".."), "Choose a valid file path.");
const relativePathSchema = pathSchema.refine(value => !path.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !value.includes("\\") && !value.split("/").some(part => part === "." || part === ""));
const optionalPath = (value) => value ? relativePathSchema.parse(value) : undefined;
const offsetSchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const kindSchema = z.enum(KIND_VALUES);
const limitSchema = z.coerce.number().int().min(1).max(500);
const topSchema = z.coerce.number().int().min(1).max(100);
/** The 404 a route throws when the project has no index on this computer. */
function noIndex(project) {
    return new BridgeError(404, `No code index for "${project}" on this computer. Build one with: phren code index ${project}`);
}
/** The phone names a project and an optional query; both are validated here. */
export class CodeRoutes {
    store;
    constructor(store) {
        this.store = store;
    }
    async status(projectValue) {
        const project = projectSchema.parse(projectValue ?? "");
        const result = await (await requireCodePackage(this.store)).codeIndexStatus(this.store, project);
        if (!result.available)
            throw noIndex(project);
        return result;
    }
    async search(projectValue, queryValue, kindValue, limitValue, directoryValue) {
        const project = projectSchema.parse(projectValue ?? "");
        const query = querySchema.parse(queryValue ?? "");
        const kind = kindValue === null || kindValue === "" ? undefined : kindSchema.parse(kindValue);
        const limit = limitValue === null || limitValue === "" ? undefined : limitSchema.parse(limitValue);
        const result = await (await requireCodePackage(this.store)).search(this.store, project, query, kind, limit ?? 20, optionalPath(directoryValue));
        if (!result.available)
            throw noIndex(project);
        return { project, query, symbols: result.value };
    }
    async tree(projectValue, directoryValue) {
        const project = projectSchema.parse(projectValue ?? "");
        const directory = optionalPath(directoryValue) ?? "";
        const result = await (await requireCodePackage(this.store)).treeSummary(this.store, project, directory);
        if (!result.available)
            throw noIndex(project);
        return { project, directory, entries: result.value };
    }
    async usagePage(projectValue, values = {}) {
        const project = projectSchema.parse(projectValue ?? "");
        const result = await (await requireCodePackage(this.store)).usagePage(this.store, project, {
            kind: values.kind ? kindSchema.parse(values.kind) : undefined,
            file: optionalPath(values.file), directory: optionalPath(values.directory),
            offset: values.offset ? offsetSchema.parse(values.offset) : 0,
            limit: values.limit ? topSchema.parse(values.limit) : 50,
            end: values.end ? z.enum(["0", "1"]).parse(values.end) === "1" : false,
        });
        if (!result.available)
            throw noIndex(project);
        return { project, ...result.value };
    }
    /** The checkout this computer indexes for `project`, or a 404 naming the project. */
    async checkout(project) {
        try {
            return fs.realpathSync((await requireCodePackage(this.store)).resolveRepoRoot(this.store, project));
        }
        catch {
            throw new BridgeError(404, `${project} has no checkout on this computer.`);
        }
    }
    async changedIn(project, added) {
        const code = await requireCodePackage(this.store);
        if (typeof code.changedDeclarations !== "function")
            throw new BridgeError(503, "Update @phren/code to see what changed.");
        const result = await code.changedDeclarations(this.store, project, new Map([...added].map(([file, lines]) => [file, [...lines].sort((a, b) => a - b)])));
        if (!result.available)
            throw noIndex(project);
        return result.value;
    }
    /**
     * What changed: the functions, types and variables that today's agent
     * sessions edited in this project's checkout, and its last 10 commits,
     * grouped by file, most recent work first. Session edits carry the line
     * numbers they had when made, so a later edit to the same file can shift one.
     */
    async whatChanged(projectValue, now = new Date()) {
        const project = projectSchema.parse(projectValue ?? "");
        const root = await this.checkout(project);
        const code = await requireCodePackage(this.store);
        const added = new Map();
        const take = (patch) => {
            for (const [file, lines] of code.addedLinesByFile(patch)) {
                const set = added.get(file) ?? new Set();
                for (const line of lines)
                    set.add(line);
                added.set(file, set);
            }
        };
        const midnight = new Date(now);
        midnight.setHours(0, 0, 0, 0);
        const dir = path.join(bridgeRoot(), "changes");
        const logs = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith(".jsonl")) : [];
        const today = logs.map(name => ({ file: path.join(dir, name), at: fs.statSync(path.join(dir, name)).mtimeMs }))
            .filter(entry => entry.at >= midnight.getTime()).sort((a, b) => b.at - a.at);
        for (const log of today) {
            for (const line of fs.readFileSync(log.file, "utf8").split("\n")) {
                if (!line.trim())
                    continue;
                let record;
                try {
                    record = JSON.parse(line);
                }
                catch {
                    continue;
                }
                for (const file of record.files ?? []) {
                    if (typeof file.root !== "string" || typeof file.patch !== "string")
                        continue;
                    let same = false;
                    try {
                        same = fs.realpathSync(file.root) === root;
                    }
                    catch {
                        same = false;
                    }
                    if (same)
                        take(file.patch);
                }
            }
        }
        // A repository's first commit adds every file; it is the import, not work.
        try {
            take(await git(root, "-c", "log.showRoot=false", "log", "-10", "--format=", "-p", "-U0", "--no-color", "--no-ext-diff"));
        }
        catch { /* A checkout without commits yet has only its session edits. */ }
        const items = await this.changedIn(project, added);
        const files = [];
        for (const item of items) {
            let group = files.find(entry => entry.path === item.file);
            if (!group) {
                group = { path: item.file, items: [] };
                files.push(group);
            }
            group.items.push(item);
        }
        return { project, files };
    }
    /**
     * Per-file counts for the Changes tree's chips: functions and types the
     * working tree changes or adds (variables stay out to keep a chip short).
     * An untracked file is new throughout.
     */
    async changeCounts(projectValue, pathsValue) {
        const project = projectSchema.parse(projectValue ?? "");
        let raw;
        try {
            raw = JSON.parse(pathsValue ?? "[]");
        }
        catch {
            throw new BridgeError(400, "Choose valid paths.");
        }
        const paths = [...new Set(z.array(relativePathSchema).min(1).max(200).parse(raw))];
        const root = await this.checkout(project);
        const code = await requireCodePackage(this.store);
        const added = new Map();
        for (const [file, lines] of code.addedLinesByFile(await git(root, "diff", "HEAD", "-U0", "--no-color", "--no-ext-diff", "--", ...paths).catch(() => "")))
            added.set(file, new Set(lines));
        const untracked = (await git(root, "ls-files", "--others", "--exclude-standard", "--", ...paths).catch(() => "")).split("\n").filter(Boolean);
        for (const file of untracked) {
            let count = 0;
            try {
                count = fs.readFileSync(path.join(root, file), "utf8").split("\n").length;
            }
            catch {
                continue;
            }
            added.set(file, new Set(Array.from({ length: count }, (_, index) => index + 1)));
        }
        const items = await this.changedIn(project, added);
        const entries = paths.map(file => {
            const mine = items.filter(item => item.file === file || item.file.startsWith(file + "/"));
            const tally = (family) => ({
                changed: mine.filter(item => item.family === family && !item.isNew).length,
                added: mine.filter(item => item.family === family && item.isNew).length,
            });
            const first = mine.find(item => item.family !== "variable");
            return { path: file, functions: tally("function"), types: tally("type"),
                ...(first ? { first: `${first.file}::${first.parent ? first.parent + "." : ""}${first.name}` } : {}) };
        });
        return { project, entries };
    }
    /** Turns code intelligence off for a project: its index is deleted, and
     * the reindexer follows only projects that have one, so nothing rebuilds it
     * until the phone turns it on again. */
    async disable(projectValue) {
        const project = projectSchema.parse(projectValue ?? "");
        const { codeDatabasePath } = await requireCodePackage(this.store);
        const file = codeDatabasePath(this.store, project);
        await Promise.all([file, `${file}-journal`, `${file}-wal`, `${file}-shm`].map(path => rm(path, { force: true })));
        return { project, disabled: true };
    }
    async reindex(projectValue) {
        const project = projectSchema.parse(projectValue ?? "");
        await indexProject(this.store, project);
        return this.status(project);
    }
    async outline(projectValue, pathValue) {
        const project = projectSchema.parse(projectValue ?? "");
        const file = pathSchema.parse(pathValue ?? "");
        const result = await (await requireCodePackage(this.store)).outline(this.store, project, file);
        if (!result.available)
            throw noIndex(project);
        return { project, path: file, entries: result.value };
    }
    /** Resolved uses made from one file, with the declaration each names, so the
     * phone's code viewer can make those identifiers tappable. */
    async fileReferences(projectValue, pathValue) {
        const project = projectSchema.parse(projectValue ?? "");
        const file = relativePathSchema.parse(pathValue ?? "");
        const code = await requireCodePackage(this.store);
        if (typeof code.fileReferences !== "function")
            throw new BridgeError(503, "Update @phren/code to make identifiers tappable.");
        const result = await code.fileReferences(this.store, project, file);
        if (!result.available)
            throw noIndex(project);
        return { project, path: file, references: result.value };
    }
    async outlineSummary(projectValue, pathsValue) {
        const project = projectSchema.parse(projectValue ?? "");
        let raw;
        try {
            raw = JSON.parse(pathsValue ?? "[]");
        }
        catch {
            throw new BridgeError(400, "Choose valid paths.");
        }
        const paths = z.array(pathSchema.refine(value => !path.isAbsolute(value) && !path.win32.isAbsolute(value)
            && !value.split(/[\\/]/).includes(".."))).min(1).max(200).parse(raw);
        const result = await (await requireCodePackage(this.store)).outlineSummary(this.store, project, [...new Set(paths)]);
        if (!result.available)
            throw noIndex(project);
        return { project, entries: result.value };
    }
    async definition(projectValue, symbolValue) {
        const project = projectSchema.parse(projectValue ?? "");
        const symbol = symbolSchema.parse(symbolValue ?? "");
        const result = await (await requireCodePackage(this.store)).definition(this.store, project, symbol);
        if (!result.available)
            throw noIndex(project);
        if (!result.value)
            throw new BridgeError(404, `Nothing named "${symbol}" in ${project}.`);
        return { project, definition: { ...result.value, findings: (await requireCodePackage(this.store)).findingsCitingSymbol(this.store, project, (await requireCodePackage(this.store)).citationSymbolName(result.value.symbol)) } };
    }
    async references(projectValue, symbolValue, limitValue) {
        const project = projectSchema.parse(projectValue ?? "");
        const symbol = symbolSchema.parse(symbolValue ?? "");
        const limit = limitValue === null || limitValue === "" ? undefined : limitSchema.parse(limitValue);
        const result = await (await requireCodePackage(this.store)).references(this.store, project, symbol, limit ?? 200);
        if (!result.available)
            throw noIndex(project);
        if (!result.value)
            throw new BridgeError(404, `Nothing named "${symbol}" in ${project}.`);
        return { project, references: result.value };
    }
    async usage(projectValue, topValue) {
        const project = projectSchema.parse(projectValue ?? "");
        const top = topValue === null || topValue === "" ? undefined : topSchema.parse(topValue);
        const result = await (await requireCodePackage(this.store)).usage(this.store, project, top ?? 10);
        if (!result.available)
            throw noIndex(project);
        return { project, usage: { hot: result.value.top, cold: result.value.bottom } };
    }
}
/**
 * Re-indexes a project when the git module's change capture records a file
 * event inside it. The Hook only constructs this while the `code` module is on,
 * and only projects that already have an index are followed. A branch switch
 * (the repository's HEAD moved) upgrades the pending run to a full re-index.
 */
export class CodeReindexer {
    store;
    index;
    log;
    debounceMs;
    timers = new Map();
    pendingFull = new Set();
    running = new Set();
    rerun = new Set();
    heads = new Map();
    closed = false;
    constructor(options) {
        this.store = options.store;
        this.index = options.index ?? indexProject;
        this.log = options.log ?? (line => logger.info("code", line));
        this.debounceMs = options.debounceMs ?? 500;
    }
    /** One recorded change event; schedules an incremental re-index of the project it belongs to. */
    record(files) {
        if (this.closed || files.length === 0)
            return;
        void this.recordAsync(files).catch(error => this.log(errorMessage(error)));
    }
    async recordAsync(files) {
        const projects = await this.indexedProjects();
        if (this.closed)
            return;
        for (const root of new Set(files.map(file => file.root))) {
            const project = projects.find(entry => entry.root === root);
            if (!project)
                continue;
            const head = readHead(root);
            const previous = this.heads.get(root);
            if (head !== undefined)
                this.heads.set(root, head);
            this.schedule(project.project, previous !== undefined && head !== undefined && previous !== head);
        }
    }
    close() {
        this.closed = true;
        for (const timer of this.timers.values())
            clearTimeout(timer);
        this.timers.clear();
        this.rerun.clear();
        this.pendingFull.clear();
    }
    async indexedProjects() {
        const { codeDatabasePath, resolveRepoRoot } = await requireCodePackage(this.store);
        const result = [];
        for (const directory of getProjectDirs(this.store)) {
            const project = path.basename(directory);
            if (!fs.existsSync(codeDatabasePath(this.store, project)))
                continue;
            try {
                result.push({ project, root: fs.realpathSync(resolveRepoRoot(this.store, project)) });
            }
            catch { /* No checkout for this project on this computer. */ }
        }
        return result;
    }
    schedule(project, full) {
        if (this.closed)
            return;
        if (full)
            this.pendingFull.add(project);
        const existing = this.timers.get(project);
        if (existing)
            clearTimeout(existing);
        const timer = setTimeout(() => { this.timers.delete(project); void this.run(project); }, this.debounceMs);
        timer.unref?.();
        this.timers.set(project, timer);
    }
    async run(project) {
        if (this.closed)
            return;
        // A run already in flight: let it finish, then take the newest event.
        if (this.running.has(project)) {
            this.rerun.add(project);
            return;
        }
        const full = this.pendingFull.delete(project);
        this.running.add(project);
        try {
            const result = await this.index(this.store, project, { full });
            this.log(`re-indexed ${project}${full ? " (full)" : ""}: ${result.parsed} parsed, ${result.symbols} declarations, ${result.durationMs} ms`);
        }
        catch (error) {
            this.log(`re-index of ${project} failed: ${errorMessage(error)}`);
        }
        finally {
            this.running.delete(project);
            if (this.rerun.delete(project))
                this.schedule(project, false);
        }
    }
}
/** HEAD of the repository root, for branch-switch detection. A linked worktree's
 * `.git` is a file that points at its real git directory. */
function readHead(root) {
    try {
        const dotGit = path.join(root, ".git");
        const gitDirectory = fs.statSync(dotGit).isDirectory()
            ? dotGit
            : (() => {
                const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
                return match ? path.resolve(root, match[1]) : undefined;
            })();
        if (!gitDirectory)
            return undefined;
        return fs.readFileSync(path.join(gitDirectory, "HEAD"), "utf8").trim();
    }
    catch {
        return undefined;
    }
}
