import { readFile } from "node:fs/promises";
import { serve } from "./server.js";
import { dispatch, health } from "./transport.js";
import { install, rollback, uninstall } from "./install.js";
import { servers } from "./herdr.js";
import { agentHook } from "./agent-hooks.js";
import { provider } from "./protocol.js";
import { AccountUsageReader, captureClaudeUsage } from "./usage.js";
import { acceptComputer, enrollComputer } from "./computers.js";
import { ARCHIVE_MAX_FOLDERS, archiveFinishedFanouts, FANOUTS_ARCHIVE_USAGE, parseFanoutArchiveFlags } from "./fanouts.js";

export async function runBridge(args: string[], version: string): Promise<number> {
  switch (args[0]) {
    case "enroll-computer": {
      if (args.length === 2) console.log(await enrollComputer(args[1]));
      else if (args.length === 4 && args[2] === "--accept") {
        await acceptComputer(args[1], await readFile(args[3], "utf8"));
        console.log(`Enrolled ${args[1]} for Phren Hook.`);
      } else throw new Error("Usage: phren bridge enroll-computer <name> [--accept <public-key-file>]");
      break;
    }
    case "fanouts": {
      if (args[1] !== "archive") throw new Error(FANOUTS_ARCHIVE_USAGE);
      const options = parseFanoutArchiveFlags(args.slice(2));
      const dryRun = options.dryRun ?? false;
      const { moved, deleted } = await archiveFinishedFanouts(process.env, options);
      const doing = dryRun ? "Would archive" : "Archived";
      const removal = dryRun ? "would delete" : "deleted";
      console.log(`${doing} ${moved.length} fan-out job(s); ${removal} ${deleted} past the ${ARCHIVE_MAX_FOLDERS}-folder cap.`);
      break;
    }
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
      break;
    }
    default: throw new Error("Usage: phren bridge <install|status|doctor|usage|update|rollback|uninstall|enroll-computer|fanouts archive>");
  }
  return 0;
}
