/** Shared settings persistence for agent TUI and REPL. */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
export const SETTINGS_FILE = path.join(os.homedir(), ".phren-agent", "settings.json");
export function loadInputMode() {
    try {
        const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
        if (data.inputMode === "queue")
            return "queue";
    }
    catch { }
    return "steering";
}
export function saveInputMode(mode) {
    try {
        const dir = path.dirname(SETTINGS_FILE);
        fs.mkdirSync(dir, { recursive: true });
        let data = {};
        try {
            data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
        }
        catch { }
        data.inputMode = mode;
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2) + "\n");
    }
    catch { }
}
export function savePermissionMode(mode) {
    try {
        const dir = path.dirname(SETTINGS_FILE);
        fs.mkdirSync(dir, { recursive: true });
        let data = {};
        try {
            data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
        }
        catch { }
        data.permissionMode = mode;
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2) + "\n");
    }
    catch { }
}
