import * as fs from "fs";
import * as path from "path";
import { debugLog, homeDir, homePath } from "./shared.js";
import { errorMessage } from "./utils.js";
const DEFAULT_SEARCH_PATHS = [
    homeDir(),
    homePath("Sites"),
    homePath("Projects"),
    homePath("Code"),
    homePath("dev"),
];
export function findProjectDir(name) {
    const extra = process.env.PROJECTS_DIR ? [process.env.PROJECTS_DIR] : [];
    for (const base of [...extra, ...DEFAULT_SEARCH_PATHS]) {
        const candidate = path.join(base, name);
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory())
                return candidate;
        }
        catch (err) {
            debugLog(`findProjectDir: failed to check ${candidate}: ${errorMessage(err)}`);
        }
    }
    return null;
}
