import * as fs from "fs";
import * as path from "path";
import {
  phrenErr,
  PhrenError,
  phrenOk,
  type PhrenResult,
} from "../shared.js";
import { withFileLock as withFileLockRaw } from "./shared-governance.js";
import { isValidProjectName, safeProjectPath, errorMessage } from "../utils.js";

export function withSafeLock<T>(filePath: string, fn: () => PhrenResult<T>): PhrenResult<T> {
  try {
    return withFileLockRaw(filePath, fn);
  } catch (err: unknown) {
    const msg = errorMessage(err);
    if (msg.includes("could not acquire lock")) {
      return phrenErr(`Could not acquire write lock for "${path.basename(filePath)}". Another write may be in progress; please retry.`, PhrenError.LOCK_TIMEOUT);
    }
    throw err;
  }
}

export function ensureProject(phrenPath: string, project: string): PhrenResult<string> {
  if (!isValidProjectName(project)) return phrenErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, PhrenError.INVALID_PROJECT_NAME);
  const dir = safeProjectPath(phrenPath, project);
  if (!dir) return phrenErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, PhrenError.INVALID_PROJECT_NAME);
  if (!fs.existsSync(dir)) {
    return phrenErr(`No project "${project}" found. Add it with 'cd ~/your-project && phren add'.`, PhrenError.PROJECT_NOT_FOUND);
  }
  return phrenOk(dir);
}
