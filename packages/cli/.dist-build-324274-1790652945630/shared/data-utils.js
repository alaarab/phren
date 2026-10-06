import * as fs from "fs";
import * as path from "path";
import { phrenErr, PhrenError, phrenOk, parsePhrenErrorCode, } from "../shared.js";
import { withFileLock as withFileLockRaw } from "../governance/locks.js";
import { isValidProjectName, safeProjectPath, errorMessage } from "../utils.js";
import { resolveProject } from "../store-routing.js";
export function withSafeLock(filePath, fn) {
    try {
        return withFileLockRaw(filePath, fn);
    }
    catch (err) {
        const msg = errorMessage(err);
        if (msg.includes("could not acquire lock")) {
            return phrenErr(`Could not acquire write lock for "${path.basename(filePath)}". Another write may be in progress; please retry.`, PhrenError.LOCK_TIMEOUT);
        }
        throw err;
    }
}
/**
 * Recursively walk a directory and return paths of files matching an optional filter.
 * Defaults to `.md` files only. Uses an iterative stack to avoid recursion limits.
 */
export function walkDirectory(root, filter) {
    const accept = filter ?? ((name) => name.endsWith(".md"));
    const results = [];
    if (!fs.existsSync(root))
        return results;
    const stack = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (entry.isFile() && accept(entry.name)) {
                results.push(fullPath);
            }
        }
    }
    return results;
}
export function ensureProject(phrenPath, project) {
    if (!isValidProjectName(project))
        return phrenErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, PhrenError.INVALID_PROJECT_NAME);
    const dir = safeProjectPath(phrenPath, project);
    if (!dir)
        return phrenErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, PhrenError.INVALID_PROJECT_NAME);
    if (fs.existsSync(dir))
        return phrenOk(dir);
    // Not in the primary store — the project may live in a registered secondary store.
    try {
        return phrenOk(resolveProject(phrenPath, project).projectDir);
    }
    catch (err) {
        const msg = errorMessage(err);
        if (parsePhrenErrorCode(msg) === PhrenError.VALIDATION_ERROR) {
            return phrenErr(msg.replace(/^[A-Z_]+:\s*/, ""), PhrenError.VALIDATION_ERROR);
        }
        return phrenErr(`No project "${project}" found. Add it with 'cd ~/your-project && phren add'.`, PhrenError.PROJECT_NOT_FOUND);
    }
}
