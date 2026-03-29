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
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")) as PackageJsonShape;
}

const PACKAGE_JSON = readPackageJson();

export const PACKAGE_NAME = PACKAGE_JSON.name || "phren";
export const VERSION = PACKAGE_JSON.version || "0.0.0";
export const PACKAGE_SPEC = `${PACKAGE_NAME}@${VERSION}`;

