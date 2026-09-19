import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.join(__dirname, "..");
const PACKAGE_JSON_PATH = path.join(ROOT, "package.json");

interface PackageJsonShape {
  name?: string;
  version?: string;
}

function readPackageJson(): PackageJsonShape {
  // The Hook bundle is copied alone into the bridge's version folder, where
  // no package.json sits beside it; the build inlines PHREN_HOOK_VERSION.
  try { return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")) as PackageJsonShape; }
  catch { return {}; }
}

declare const PHREN_HOOK_VERSION: string | undefined;
const BUNDLED_VERSION = typeof PHREN_HOOK_VERSION === "string" ? PHREN_HOOK_VERSION : "0.0.0";
const PACKAGE_JSON = readPackageJson();

export const PACKAGE_NAME = PACKAGE_JSON.name || "phren";
export const VERSION = PACKAGE_JSON.version || BUNDLED_VERSION;
export const PACKAGE_SPEC = `${PACKAGE_NAME}@${VERSION}`;

