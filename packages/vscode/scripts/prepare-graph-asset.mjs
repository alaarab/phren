import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = [
  "memory-ui-graph.runtime.js",
];

for (const asset of assets) {
  const sourcePath = path.resolve(extensionRoot, "..", "cli", "dist", asset);
  const targetPath = path.resolve(extensionRoot, "out", asset);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing graph engine asset at ${sourcePath}. Run the root Phren build before packaging the VS Code extension.`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  process.stdout.write(`Copied ${asset} to ${targetPath}\n`);
}
