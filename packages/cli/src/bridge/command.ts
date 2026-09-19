import { serve } from "./server.js";
import { dispatch, health } from "./transport.js";
import { install, rollback, uninstall } from "./install.js";
import { servers } from "./herdr.js";
import { agentHook } from "./agent-hooks.js";
import { provider } from "./protocol.js";
import { AccountUsageReader, captureClaudeUsage } from "./usage.js";

export async function runBridge(args: string[], version: string): Promise<number> {
  switch (args[0]) {
    case "usage-statusline": await captureClaudeUsage(args[1] || ""); break;
    case "usage": console.log(JSON.stringify(await new AccountUsageReader().read(), null, 2)); break;
    case "hook": await agentHook(provider.parse(args[1])).catch(() => {}); break;
    case "serve": await serve(version); break;
    case "ssh": await dispatch(process.env.SSH_ORIGINAL_COMMAND || ""); break;
    case "install": case "update": await install(version, args.includes("--no-service")); break;
    case "uninstall": await uninstall(); break;
    case "rollback": await rollback(); break;
    case "status": console.log(JSON.stringify(await health(), null, 2)); break;
    case "doctor": {
      const helper = await health(), muxes = await servers();
      // Chat needs Herdr; a plain project shell or agent over SSH does not.
      console.log(JSON.stringify({ ok: true, helper, herdr: muxes, checks: {
        privateSocket: true, protocol: true, independentHelper: true,
        herdrRunning: muxes.length > 0, terminal: "SSH PTY; authorize the Phren device key with pty",
        shell: muxes.length > 0 ? "available" : "Herdr is not running: chat is unavailable, project shells and agents still open over SSH",
      } }, null, 2));
    }
    default: throw new Error("Usage: phren bridge <install|status|doctor|usage|update|rollback|uninstall>");
  }
  return 0;
}
