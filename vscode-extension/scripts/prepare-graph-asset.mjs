import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.resolve(extensionRoot, "..", "mcp", "dist", "memory-ui-graph.js");
const targetPath = path.resolve(extensionRoot, "out", "memory-ui-graph.js");

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Missing graph engine at ${sourcePath}. Run the root Cortex build before packaging the VS Code extension.`);
}

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.copyFileSync(sourcePath, targetPath);
process.stdout.write(`Copied memory-ui-graph.js to ${targetPath}\n`);
