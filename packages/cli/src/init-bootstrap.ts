/**
 * Bootstrap-current-project prompting and execution for init.
 */
import { debugLog } from "./shared.js";
import {
  bootstrapFromExisting,
} from "./init/setup.js";
import {
  type ProjectOwnershipMode,
} from "./project-config.js";
import { log } from "./init/shared.js";

/**
 * Bootstrap a project from an existing directory into phren.
 */
export function bootstrapProject(
  phrenPath: string,
  projectPath: string,
  profile: string | undefined,
  ownership: ProjectOwnershipMode,
  label: string,
): void {
  try {
    const created = bootstrapFromExisting(phrenPath, projectPath, {
      profile,
      ownership,
    });
    log(`\n${label} "${created.project}" (${created.ownership})`);
  } catch (e: unknown) {
    debugLog(`Bootstrap from CWD failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
