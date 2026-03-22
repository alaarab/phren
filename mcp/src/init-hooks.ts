/**
 * Hook configuration helper for init.
 */
import { configureAllHooks } from "./hooks.js";
import { debugLog } from "./shared.js";
import { errorMessage } from "./utils.js";
import { log } from "./init/shared.js";

/**
 * Configure hooks if enabled, or log a disabled message.
 * @param verb - label used in log messages, e.g. "Updated" or "Configured"
 */
export function configureHooksIfEnabled(phrenPath: string, hooksEnabled: boolean, verb: string): void {
  if (hooksEnabled) {
    try {
      const hooked = configureAllHooks(phrenPath, { allTools: true });
      if (hooked.length) log(`  ${verb} hooks: ${hooked.join(", ")}`);
    } catch (err: unknown) { debugLog(`configureAllHooks failed: ${errorMessage(err)}`); }
  } else {
    log(`  Hooks are disabled by preference (run: npx phren hooks-mode on)`);
  }
}
