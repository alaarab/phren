import { nonInteractiveGitEnv } from "../utils-helpers.js";
declare const PHREN_HOOK_VERSION: string;
Object.assign(process.env, nonInteractiveGitEnv());
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  // sudo starts a fresh process for every password attempt. It needs only
  // the askpass client, rather than initializing the Hook server and tools.
  if (args[0] === "askpass") {
    const { askpass } = await import("./sudo.js");
    return askpass(args[1]);
  }
  const { runBridge } = await import("./command.js");
  return runBridge(args, PHREN_HOOK_VERSION);
}
main().then(code => {
  process.exitCode = code;
}).catch(error => {
  console.error(error instanceof Error ? error.message : "Phren Hook failed.");
  process.exitCode = 1;
});
