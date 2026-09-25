import { readFile } from "node:fs/promises";
import { serve } from "./server.js";
import { dispatch, health } from "./transport.js";
import { install, rollback, uninstall } from "./install.js";
import { servers } from "./herdr.js";
import { agentHook } from "./agent-hooks.js";
import { object, provider, type Json } from "./protocol.js";
import { apnsSetupSteps } from "./push.js";
import { speechKeyFile, speechKeyStatus, writeSpeechKey } from "./speech-key.js";
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
    case "speech-key": {
      // The key comes from stdin, never argv, so it stays out of ps and shell history.
      if (args[1] !== "set" || args.length !== 2) throw new Error(SPEECH_KEY_USAGE);
      await writeSpeechKey(await readSecret("ElevenLabs API key: "));
      console.log(`Stored the ElevenLabs key in ${speechKeyFile()} (mode 600).`);
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
      const push = approvalPushCheck(helper), speech = await speechKeyStatus();
      // Chat needs Herdr; a plain project shell or agent over SSH does not.
      console.log(JSON.stringify({ ok: true, helper, herdr: muxes, checks: {
        privateSocket: true, protocol: true, independentHelper: true,
        herdrRunning: muxes.length > 0, terminal: "SSH PTY; authorize the Phren device key with pty",
        shell: muxes.length > 0 ? "available" : "Herdr is not running: chat is unavailable, project shells and agents still open over SSH",
        approvalPush: push.configured ? "configured" : "not configured",
        speechKey: speech.configured ? "configured" : "not configured", speechKeyDetail: speech.detail,
      }, ...(push.warning ? { warnings: [push.warning] } : {}) }, null, 2));
      if (push.warning) console.error(`warning: ${push.warning}`);
      break;
    }
    default: throw new Error("Usage: phren bridge <install|status|doctor|usage|update|rollback|uninstall|enroll-computer|fanouts archive|speech-key set>");
  }
  return 0;
}

/** Doctor's push check, from the running Hook's own capability: only a Hook
 * that loaded apns.json and its key offers `approvalPush`. */
export function approvalPushCheck(helper: Json): { configured: boolean; warning?: string } {
  const configured = object(helper.capabilities).approvalPush === "direct-apns";
  return configured ? { configured } : { configured, warning: apnsSetupSteps() };
}

const SPEECH_KEY_USAGE = "Usage: phren bridge speech-key set  (paste the key when asked, or pipe it on stdin)";

/** One line from stdin: piped as is, or typed at a prompt without echo. */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let text = "";
    for await (const chunk of stdin) text += chunk;
    return text;
  }
  process.stderr.write(prompt);
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => { stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); process.stderr.write("\n"); };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") { finish(); resolve(value); return; }
        if (char === "\u0003") { finish(); reject(new Error("Cancelled.")); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}
