import { runBridge } from "./command.js";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
declare const PHREN_HOOK_VERSION: string;
Object.assign(process.env, nonInteractiveGitEnv());
runBridge(process.argv.slice(2), PHREN_HOOK_VERSION).then(code => {
  process.exitCode = code;
}).catch(error => {
  console.error(error instanceof Error ? error.message : "Phren Hook failed.");
  process.exitCode = 1;
});
