import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
function isGitRepo(cwd) {
    try {
        execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return true;
    }
    catch {
        return false;
    }
}
function storeFile(_cwd) {
    const dir = path.join(os.homedir(), ".phren-agent");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "checkpoints.json");
}
function loadStore(cwd) {
    const file = storeFile(cwd);
    if (fs.existsSync(file)) {
        try {
            return JSON.parse(fs.readFileSync(file, "utf-8"));
        }
        catch { /* ignore corrupt */ }
    }
    return { checkpoints: [] };
}
function saveStore(cwd, store) {
    fs.writeFileSync(storeFile(cwd), JSON.stringify(store, null, 2) + "\n");
}
/**
 * Create a checkpoint via `git stash create`. Returns the ref or null if
 * the working tree is clean (stash create produces no output when clean).
 */
export function createCheckpoint(cwd, label) {
    if (!isGitRepo(cwd))
        return null;
    try {
        const ref = execFileSync("git", ["stash", "create"], {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        if (!ref)
            return null; // clean working tree
        // Store the ref so `git gc` won't collect it
        execFileSync("git", ["stash", "store", "-m", label || "phren-checkpoint", ref], {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        const store = loadStore(cwd);
        store.checkpoints.push({
            ref,
            label: label || `checkpoint-${store.checkpoints.length + 1}`,
            createdAt: new Date().toISOString(),
        });
        saveStore(cwd, store);
        return ref;
    }
    catch {
        return null;
    }
}
