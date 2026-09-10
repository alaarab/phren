import { runBridge } from "./command.js";
declare const PHREN_HOOK_VERSION: string;
runBridge(process.argv.slice(2), PHREN_HOOK_VERSION).then(code => {
  process.exitCode = code;
}).catch(error => {
  console.error(error instanceof Error ? error.message : "Phren Hook failed.");
  process.exitCode = 1;
});
