import * as fs from "fs";
import * as path from "path";
import { debugLog } from "./shared.js";
import { errorMessage } from "./utils.js";
export function recordRetrieval(phrenPath, file, section) {
    const dir = path.join(phrenPath, ".runtime");
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, "retrieval-log.jsonl");
    const entry = { file, section, retrievedAt: new Date().toISOString() };
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
    try {
        const stat = fs.statSync(logPath);
        if (stat.size > 500_000) {
            const content = fs.readFileSync(logPath, "utf8");
            const lines = content.split("\n").filter(Boolean);
            fs.writeFileSync(logPath, lines.slice(-1000).join("\n") + "\n");
        }
    }
    catch (err) {
        debugLog(`recordRetrieval rotation failed: ${errorMessage(err)}`);
    }
}
