#!/usr/bin/env node
// Phren desktop daemon and its key commands. Wires the modules declared in contract.ts.
//   phren-desktop                      serve the UI (default)
//   phren-desktop enroll               create this desktop's key and print its authorized_keys line
//   phren-desktop link <host> [--name N] [--server S]
//   phren-desktop revoke <name>
//   phren-desktop list
import { randomBytes } from "node:crypto";
import { loadComputers } from "./hosts.js";
import { hookRequest, hookWebSocket } from "./hook-client.js";
import { enrollDesktop, linkComputer, revokeComputer } from "./keys.js";
import { createOverviewHub } from "./overview.js";
import { attachTerminal } from "./pty-bridge.js";
import { startServer } from "./server.js";

const [command = "serve", ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
}

async function serve(): Promise<void> {
  const port = Number(process.env.PHREN_DESKTOP_PORT ?? 0);
  const token = process.env.PHREN_DESKTOP_TOKEN ?? randomBytes(24).toString("hex");
  const computers = await loadComputers();
  const hub = createOverviewHub(computers, hookWebSocket);
  hub.start();
  const server = await startServer({ port, token, computers, hub, hookRequest, hookWebSocket, attachTerminal });
  process.stdout.write(`Phren desktop: ${server.url}\n`);
  const stop = async () => { hub.stop(); await server.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function run(): Promise<void> {
  switch (command) {
    case "serve": return serve();
    case "enroll": {
      const { line } = await enrollDesktop();
      process.stdout.write(`${line}\n`);
      return;
    }
    case "link": {
      const host = rest[0];
      if (!host || host.startsWith("-")) throw new Error("Usage: phren-desktop link <host> [--name <name>] [--server <server>]");
      const computer = await linkComputer(host, { name: flag("name"), server: flag("server") });
      process.stdout.write(`Linked ${computer.name} (${computer.username}@${computer.address}:${computer.port}).\n`);
      return;
    }
    case "revoke": {
      const name = rest[0];
      if (!name) throw new Error("Usage: phren-desktop revoke <name>");
      const { remote } = await revokeComputer(name);
      process.stdout.write(remote
        ? `Revoked ${name}: its key line is removed there and it is out of desktop.yaml.\n`
        : `Removed ${name} from desktop.yaml, but could not reach it to remove the key line. Remove the phren-desktop line from its ~/.ssh/authorized_keys by hand.\n`);
      return;
    }
    case "list": {
      for (const c of await loadComputers()) {
        process.stdout.write(c.local ? `${c.name}\tlocal\n` : `${c.name}\t${c.username}@${c.address}:${c.port}\t${c.keyFile?.endsWith("id_ed25519_desktop") ? "desktop key" : "dispatch key (hooks.yaml)"}\n`);
      }
      return;
    }
    default:
      throw new Error(`Unknown command "${command}". Use serve, enroll, link, revoke or list.`);
  }
}

run().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
