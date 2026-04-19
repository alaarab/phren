import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PACKAGE_JSON_PATH = path.join(ROOT, "package.json");
function readPackageJson() {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
}
const PACKAGE_JSON = readPackageJson();
export const VERSION = PACKAGE_JSON.version || "0.0.0";
