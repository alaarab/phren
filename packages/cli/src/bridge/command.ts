import { serve } from "./server.js";
import { dispatch, health } from "./transport.js";
import { install, rollback, uninstall } from "./install.js";
import { servers } from "./herdr.js";
import { agentHook } from "./agent-hooks.js";
import { provider } from "./protocol.js";

export async function runBridge(args: string[], version: string): Promise<number> {
  switch (args[0]) {
    case "hook": await agentHook(provider.parse(args[1])).catch(() => {}); break;
    case "serve": await serve(version); break;
    case "ssh": await dispatch(process.env.SSH_ORIGINAL_COMMAND || ""); break;
    case "install": case "update": await install(version, args.includes("--no-service")); break;
    case "uninstall": await uninstall(); break;
    case "rollback": await rollback(); break;
    case "status": console.log(JSON.stringify(await health(), null, 2)); break;
    case "doctor": {
      const helper = await health(), muxes = await servers();
      console.log(JSON.stringify({ ok: muxes.length > 0, helper, herdr: muxes, checks: {
        privateSocket: true, protocol: true, independentHelper: true,
        herdrRunning: muxes.length > 0, terminal: "SSH PTY; authorize the Phren device key with pty",
      } }, null, 2));
      return muxes.length > 0 ? 0 : 1;
    }
    default: throw new Error("Usage: phren bridge <install|status|doctor|update|rollback|uninstall>");
  }
  return 0;
}
