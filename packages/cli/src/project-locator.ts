import * as fs from "fs";
import * as path from "path";
import { debugLog, homeDir, homePath, findPhrenPath } from "./shared.js";
import { errorMessage } from "./utils.js";

const DEFAULT_SEARCH_PATHS = [
  homeDir(),
  homePath("Sites"),
  homePath("Projects"),
  homePath("projects"),
  homePath("Code"),
  homePath("code"),
  homePath("dev"),
  homePath("src"),
  homePath("repos"),
  homePath("workspace"),
];

export function findProjectDir(name: string): string | null {
  // First check the project's registered sourcePath in phren.project.yaml
  try {
    const phrenPath = findPhrenPath();
    if (phrenPath) {
      const yamlPath = path.join(phrenPath, name, "phren.project.yaml");
      if (fs.existsSync(yamlPath)) {
        const content = fs.readFileSync(yamlPath, "utf-8");
        const match = content.match(/^sourcePath:\s*(.+)$/m);
        if (match) {
          const sp = match[1].trim();
          if (fs.existsSync(sp) && fs.statSync(sp).isDirectory()) return sp;
        }
      }
    }
  } catch { /* fall through to search paths */ }

  const extra = process.env.PROJECTS_DIR ? [process.env.PROJECTS_DIR] : [];
  for (const base of [...extra, ...DEFAULT_SEARCH_PATHS]) {
    const candidate = path.join(base, name);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    } catch (err: unknown) {
      debugLog(`findProjectDir: failed to check ${candidate}: ${errorMessage(err)}`);
    }
  }
  return null;
}
