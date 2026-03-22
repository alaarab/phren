/**
 * Bootstrap-current-project prompting and execution for init.
 */
import * as path from "path";
import { debugLog } from "./shared.js";
import {
  bootstrapFromExisting,
  detectProjectDir,
} from "./init/setup.js";
import {
  PROJECT_OWNERSHIP_MODES,
  type ProjectOwnershipMode,
} from "./project-config.js";
import {
  createWalkthroughPrompts,
  createWalkthroughStyle,
} from "./init-walkthrough.js";
import { getPendingBootstrapTarget } from "./init-detect.js";
import { log } from "./init/shared.js";
import type { InitOptions } from "./init-types.js";

export interface BootstrapDecision {
  shouldBootstrap: boolean;
  ownership: ProjectOwnershipMode;
}

/**
 * Decide whether to bootstrap the CWD project and with what ownership.
 * May prompt the user interactively.
 */
export async function resolveBootstrapDecision(
  phrenPath: string,
  opts: InitOptions,
  ownershipDefault: ProjectOwnershipMode,
  dryRun: boolean,
): Promise<BootstrapDecision> {
  const pendingBootstrap = getPendingBootstrapTarget(phrenPath, opts);
  let shouldBootstrap = opts._walkthroughBootstrapCurrentProject === true;
  let ownership = opts._walkthroughBootstrapOwnership ?? ownershipDefault;

  if (pendingBootstrap && !dryRun) {
    const walkthroughAlreadyHandled = opts._walkthroughBootstrapCurrentProject !== undefined;
    if (walkthroughAlreadyHandled) {
      shouldBootstrap = opts._walkthroughBootstrapCurrentProject === true;
      ownership = opts._walkthroughBootstrapOwnership ?? ownershipDefault;
    } else if (opts.yes || !process.stdin.isTTY || !process.stdout.isTTY) {
      shouldBootstrap = true;
      ownership = ownershipDefault;
    } else {
      const prompts = await createWalkthroughPrompts();
      const style = await createWalkthroughStyle();
      const detectedProjectName = path.basename(pendingBootstrap.path);
      log("");
      log(style.header("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
      log(style.header("Current Project"));
      log(style.header("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
      log(`Detected project: ${detectedProjectName}`);
      shouldBootstrap = await prompts.confirm("Add this project to phren now?", true);
      if (!shouldBootstrap) {
        log(style.warning(`  Skipped. Later: cd ${pendingBootstrap.path} && npx phren add`));
      } else {
        ownership = await prompts.select<ProjectOwnershipMode>(
          "Ownership for detected project",
          [
            { value: ownershipDefault, name: `${ownershipDefault} (default)` },
            ...PROJECT_OWNERSHIP_MODES
              .filter((mode) => mode !== ownershipDefault)
              .map((mode) => ({ value: mode, name: mode })),
          ],
          ownershipDefault
        );
      }
    }
  }

  return { shouldBootstrap, ownership };
}

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
