/**
 * Detection helpers for init: bootstrap target, install markers, path resolution.
 */
import * as fs from "fs";
import * as path from "path";
import { expandHomePath } from "./shared.js";
import { detectProjectDir, isProjectTracked } from "./setup.js";
import { DEFAULT_PHREN_PATH } from "./shared.js";
import type { InitOptions } from "./init-types.js";

export function normalizedBootstrapProjectName(projectPath: string): string {
  return path.basename(projectPath).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

export function getPendingBootstrapTarget(
  phrenPath: string,
  _opts: InitOptions,
): { path: string; mode: "explicit" | "detected" } | null {
  const cwdProject = detectProjectDir(process.cwd(), phrenPath);
  if (!cwdProject) return null;
  const projectName = normalizedBootstrapProjectName(cwdProject);
  if (isProjectTracked(phrenPath, projectName)) return null;
  return { path: cwdProject, mode: "detected" };
}

export function hasInstallMarkers(phrenPath: string): boolean {
  // Require at least two markers to consider this a real install.
  // A partial clone or failed init may create one directory but not finish.
  if (!fs.existsSync(phrenPath)) return false;
  let found = 0;
  if (fs.existsSync(path.join(phrenPath, "machines.yaml"))) found++;
  if (fs.existsSync(path.join(phrenPath, ".config"))) found++;
  if (fs.existsSync(path.join(phrenPath, "global"))) found++;
  return found >= 2;
}

export function resolveInitPhrenPath(opts: InitOptions): string {
  const raw = opts._walkthroughStoragePath || process.env.PHREN_PATH || DEFAULT_PHREN_PATH;
  return path.resolve(expandHomePath(raw));
}
