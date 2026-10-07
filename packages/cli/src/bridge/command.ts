import { readFile } from "node:fs/promises";
import { serve } from "./server.js";
import { dispatch, health } from "./transport.js";
import { install, rollback, uninstall } from "./install.js";
import { servers } from "./herdr.js";
import { describeTerminal, terminalHealth } from "./health.js";
import { agentHook } from "./agent-hooks.js";
import { askpass } from "./sudo.js";
import { object, provider, socketPath, type Json } from "./protocol.js";
import { apnsSetupSteps } from "./push.js";
import { speechKeyFile, speechKeyStatus, writeSpeechKey } from "./speech-key.js";
import { clearSpeechModel, clearSpeechVoice, DEFAULT_SPEECH_MODEL, FALLBACK_SPEECH_MODEL, resolveSpeechModel, resolveSpeechRegion, resolveSpeechVoice, SPEECH_REGIONS, speechModelId, speechRegion, speechVoiceFile, voiceId, writeSpeechModel, writeSpeechRegion, writeSpeechVoice } from "./speech-voice.js";
import { AccountUsageReader, captureClaudeUsage, type AccountUsage } from "./usage.js";
import { acceptComputer, enrollComputer } from "./computers.js";
import { addPeerFromLink, discoverComputers, linkComputer } from "./link.js";
import { ARCHIVE_MAX_FOLDERS, archiveFinishedFanouts, FANOUTS_ARCHIVE_USAGE, parseFanoutArchiveFlags } from "./fanouts.js";
import { harnessInventory } from "./harnesses.js";
import { addClaudeAccount } from "./claude-account-setup.js";
import { setAccountLabel } from "./claude-accounts.js";
import { ModelCatalog, type AgentModel } from "./models.js";

const LINK_USAGE = "Usage: phren bridge link <ssh-host> [--name <its name here>] [--as <this computer's name there>] [--back-address <address it dials>] [--yes]";

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
    case "accounts": {
      if (args.length === 1) {
        for (const harness of (await harnessInventory()).harnesses) {
          console.log(`${harness.source}: ${harness.installed ? `installed ${harness.version ?? ""}`.trim() : "not installed"}, ${harness.usable ? "usable" : `not usable (${harness.reason ?? "unknown"})`}`);
          for (const account of harness.accounts ?? []) console.log(`  ${account.id}  ${account.label}  ${account.signedIn ? "signed in" : "not signed in"}  ${account.usable ? "usable" : `not usable (${account.reason ?? "unknown"})`}${account.plan ? `  plan ${account.plan}` : ""}`);
        }
      } else if (args[1] === "add" && args[2] && !args[2].startsWith("-")) {
        const at = args.indexOf("--label");
        if (at !== -1 && !args[at + 1]) throw new Error("Usage: phren bridge accounts add <slug> [--label <name>]");
        const added = await addClaudeAccount(args[2], { label: at === -1 ? undefined : args[at + 1] });
        console.log(`${added.created ? "Created" : "Updated"} ${added.dir}${added.linked.length ? `, linked ${added.linked.join(", ")} from the default home` : ""}.`);
        console.log(`Next: CLAUDE_CONFIG_DIR=${added.dir} claude   # finish first-run setup, run /login with this account, then /exit`);
        console.log(`Check: CLAUDE_CONFIG_DIR=${added.dir} claude auth status --text; phren bridge accounts`);
      } else if (args[1] === "label" && args.length >= 4) {
        await setAccountLabel(args[2], args.slice(3).join(" "));
        console.log(`Labeled ${args[2]} "${args.slice(3).join(" ").trim()}".`);
      } else throw new Error("Usage: phren bridge accounts [add <slug> [--label <name>] | label <id> <label>]");
      break;
    }
    case "discover": {
      const { reachable, checked } = await discoverComputers();
      if (!reachable.length) console.log(`No unlinked computers running Phren Hook answered over ssh (checked ${checked.length}: ${checked.join(", ") || "none"}).`);
      else {
        console.log("Reachable over ssh, running Phren Hook, and not linked:");
        for (const item of reachable) console.log(`  ${item.host} (${item.user})  link with: phren bridge link ${item.host}`);
      }
      break;
    }
    case "link": {
      const host = args[1];
      const flag = (name: string) => { const index = args.indexOf(name); return index > 1 ? args[index + 1] : undefined; };
      if (!host || host.startsWith("-")) throw new Error(LINK_USAGE);
      if (!args.includes("--yes")) {
        if (!process.stdin.isTTY) throw new Error(`Linking ${host} lets each computer run agents on the other. Pass --yes to confirm.`);
        const { createInterface } = await import("node:readline/promises");
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await prompt.question(`Link this computer and ${host} both ways, so each can list and start agents on the other? [y/N] `);
        prompt.close();
        if (!/^y(es)?$/i.test(answer.trim())) { console.log("Not linked."); return 1; }
      }
      const result = await linkComputer(host, { name: flag("--name"), as: flag("--as"), backAddress: flag("--back-address") });
      console.log(JSON.stringify(result, null, 2));
      return result.reachable && result.remote.reachable ? 0 : 1;
    }
    case "add-peer": {
      // The receiving half of `phren bridge link`, run by the linking computer over ssh.
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      console.log(JSON.stringify(await addPeerFromLink(Buffer.concat(chunks).toString("utf8"))));
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
    case "speech-voice": {
      // Read on every spoken reply, so a change needs no Hook restart.
      const [, action = "show", id] = args;
      if (action === "set" && id && args.length === 3) {
        if (!voiceId.safeParse(id).success) throw new Error(`"${id}" is not an ElevenLabs voice id (10 to 40 letters and digits, e.g. S9EGwlCtMF7VXtENq79v).`);
        console.log(`Talk mode now speaks with ${await writeSpeechVoice(id)} (stored in ${speechVoiceFile()}). Install and update keep it.`);
      } else if (action === "clear" && args.length === 2) {
        await clearSpeechVoice();
        const next = await resolveSpeechVoice();
        console.log(`Cleared the stored voice; talk mode uses ${next.voice} (${next.source}).`);
      } else if (action === "show" && args.length <= 2) {
        const current = await resolveSpeechVoice();
        console.log(`${current.voice} (${current.source === "setting" ? `stored in ${speechVoiceFile()}` : current.source})`);
      } else throw new Error(SPEECH_VOICE_USAGE);
      break;
    }
    case "speech-model": {
      const [, action = "show", id] = args;
      if (action === "set" && id && args.length === 3) {
        if (!speechModelId.safeParse(id).success) throw new Error(`"${id}" is not an ElevenLabs model id (e.g. ${DEFAULT_SPEECH_MODEL} or ${FALLBACK_SPEECH_MODEL}).`);
        const model = await writeSpeechModel(id);
        const fallback = model === FALLBACK_SPEECH_MODEL ? "" : `, falling back to ${FALLBACK_SPEECH_MODEL} when it fails or is slow`;
        console.log(`Talk mode now speaks with ${model} (stored in ${speechVoiceFile()})${fallback}. Install and update keep it.`);
      } else if (action === "clear" && args.length === 2) {
        await clearSpeechModel();
        console.log(`Cleared the stored model; talk mode uses ${DEFAULT_SPEECH_MODEL} (default).`);
      } else if (action === "show" && args.length <= 2) {
        const current = await resolveSpeechModel();
        console.log(`${current.model} (${current.source === "setting" ? `stored in ${speechVoiceFile()}` : current.source})`);
      } else throw new Error(SPEECH_MODEL_USAGE);
      break;
    }
    case "speech-region": {
      const [, region = "show"] = args;
      if (args.length > 2) throw new Error(SPEECH_REGION_USAGE);
      if (region === "show") {
        const current = await resolveSpeechRegion();
        console.log(`${current.region}: ${current.origin} (${current.source === "setting" ? `stored in ${speechVoiceFile()}` : current.source})`);
      } else if (speechRegion.safeParse(region).success) {
        const stored = await writeSpeechRegion(region);
        console.log(`Talk mode now reaches ElevenLabs at ${SPEECH_REGIONS[stored]} (${stored}). Install and update keep it.`);
      } else throw new Error(SPEECH_REGION_USAGE);
      break;
    }
    case "usage-statusline": await captureClaudeUsage(args[1] || ""); break;
    case "usage": console.log(JSON.stringify(await new AccountUsageReader().read(), null, 2)); break;
    case "hook": if (await agentHook(provider.parse(args[1])).catch(() => undefined) === "abandoned") process.exit(0); break;
    // sudo -A runs <bridge>/askpass, which runs this: the password on stdout, or exit 1.
    case "askpass": return askpass(args[1]);
    case "serve": {
      // The subprocess bridge suite supplies this fixture; no agent binaries or
      // machine-specific catalogue caches should affect its HTTP assertions.
      const fixture = process.env.NODE_ENV === "test" ? process.env.PHREN_TEST_MODEL_CATALOG : undefined;
      if (!fixture) { await serve(version); break; }
      const readModels = async (source: string): Promise<AgentModel[]> => {
        const rows = JSON.parse(await readFile(fixture, "utf8")) as Record<string, AgentModel[]>;
        return Array.isArray(rows[source]) ? rows[source] : [];
      };
      const emptyUsage = (source: AccountUsage["source"]): AccountUsage => ({ source, windows: [] });
      const modelCatalog = new ModelCatalog(() => readModels("codex"), () => readModels("claude"), () => readModels("opencode"), 0, () => readModels("phren"));
      const accountUsage = new AccountUsageReader(async () => emptyUsage("codex"), Date.now,
        async () => ({ source: "claude", windows: [{ id: "fixture", name: "Fixture", usedPercent: 0 }] }),
        async () => emptyUsage("opencode"), async () => undefined, async () => emptyUsage("opencode-go"), async () => emptyUsage("copilot"));
      await serve(version, { modelCatalog, accountUsage });
      break;
    }
    case "ssh": await dispatch(process.env.SSH_ORIGINAL_COMMAND || ""); break;
    case "ssh-scoped": {
      const { scopedDispatch } = await import("./scoped-gateway.js");
      await scopedDispatch(args[1] ?? "", process.env.SSH_ORIGINAL_COMMAND || "", { input: process.stdin, output: process.stdout, socket: socketPath() });
      process.stdin.destroy();
      break;
    }
    case "install": case "update": await install(version, args.includes("--no-service"), args.includes("--force")); break;
    case "uninstall": await uninstall(); break;
    case "rollback": await rollback(); break;
    case "status": console.log(JSON.stringify(await health(), null, 2)); break;
    case "doctor": {
      const helper = await health(), muxes = await servers(), terminal = await terminalHealth();
      const push = approvalPushCheck(helper), speech = await speechKeyStatus(), voice = await resolveSpeechVoice().catch(() => undefined), model = await resolveSpeechModel(), region = await resolveSpeechRegion();
      // Chat needs Herdr or tmux; a plain project shell or agent over SSH does not.
      console.log(JSON.stringify({ ok: true, helper, herdr: muxes, terminal, checks: {
        privateSocket: true, protocol: true, independentHelper: true,
        herdrRunning: terminal.servers.some(server => server.provider === "herdr"), terminal: "SSH PTY; authorize the Phren device key with pty",
        multiplexer: describeTerminal(terminal),
        shell: muxes.length > 0 ? "available" : "Neither Herdr nor tmux is available: chat is unavailable, project shells and agents still open over SSH",
        approvalPush: push.configured ? "configured" : "not configured",
        speechKey: speech.configured ? "configured" : "not configured", speechKeyDetail: speech.detail,
        ...(voice ? { speechVoice: `${voice.voice} (${voice.source})` } : {}), speechModel: `${model.model} (${model.source})`, speechRegion: `${region.region} (${region.source})`,
      }, ...(push.warning ? { warnings: [push.warning] } : {}) }, null, 2));
      if (push.warning) console.error(`warning: ${push.warning}`);
      break;
    }
    default: throw new Error("Usage: phren bridge <install|status|doctor|usage|update|rollback|uninstall|enroll-computer|accounts|discover|link|fanouts archive|speech-key set|speech-voice|speech-model|speech-region>");
  }
  return 0;
}

/** Doctor's push check, from the running Hook's own capability: a Hook that
 * loaded apns.json and its key, or one whose phones registered through the
 * push relay, offers `approvalPush`. */
export function approvalPushCheck(helper: Json): { configured: boolean; warning?: string } {
  const capability = object(helper.capabilities).approvalPush;
  const configured = capability === "direct-apns" || capability === "relay";
  return configured ? { configured } : { configured, warning: apnsSetupSteps() };
}

const SPEECH_VOICE_USAGE = "Usage: phren bridge speech-voice [show | set <elevenlabs-voice-id> | clear]";
const SPEECH_MODEL_USAGE = "Usage: phren bridge speech-model [show | set <elevenlabs-model-id> | clear]";
const SPEECH_REGION_USAGE = "Usage: phren bridge speech-region [show | us | global]";
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
