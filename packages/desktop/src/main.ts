#!/usr/bin/env node
// Phren desktop daemon and its key commands. Wires the modules declared in contract.ts.
//   phren-desktop                      serve the UI (default)
//   phren-desktop enroll               create this desktop's key and print its authorized_keys line
//   phren-desktop link <host> [--name N] [--server S]
//   phren-desktop revoke <name>
//   phren-desktop list
import { randomBytes } from "node:crypto";
import { readFileSync, watch } from "node:fs";
import type { Computer } from "./contract.js";
import { bridgeRoot, closeMasters, loadComputers } from "./hosts.js";
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

/** The Electron parent hands the token in on a file descriptor so it never
 * shows in the process environment. */
function tokenFromFd(): string | undefined {
  const raw = process.env.PHREN_DESKTOP_TOKEN_FD;
  if (!raw) return undefined;
  const fd = Number(raw);
  if (!Number.isInteger(fd) || fd < 0) throw new Error("PHREN_DESKTOP_TOKEN_FD must be a file descriptor number.");
  return readFileSync(fd, "utf8").trim();
}

/** Best-effort ControlMaster teardown for every remote computer, bounded by a
 * total budget so shutdown never hangs on a dead host. */
function closeAllMasters(computers: Computer[], budgetMs: number): Promise<void> {
  const remotes = computers.filter(computer => !computer.local);
  if (remotes.length === 0) return Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<void>(resolve => { timer = setTimeout(resolve, budgetMs); });
  return Promise.race([Promise.all(remotes.map(closeMasters)).then(() => undefined), budget])
    .catch(() => undefined)
    .finally(() => { if (timer) clearTimeout(timer); });
}

async function serve(): Promise<void> {
  const port = Number(process.env.PHREN_DESKTOP_PORT ?? 0);
  const token = tokenFromFd() ?? process.env.PHREN_DESKTOP_TOKEN ?? randomBytes(24).toString("hex");
  delete process.env.PHREN_DESKTOP_TOKEN;
  delete process.env.PHREN_DESKTOP_TOKEN_FD;

  const computers = await loadComputers();
  const hub = createOverviewHub(computers, hookWebSocket);
  hub.start();
  const server = await startServer({ port, token, computers, hub, hookRequest, hookWebSocket, attachTerminal });
  process.stdout.write(`Phren desktop: ${server.url}\n`);

  // One array instance is shared with the server and the hub; reloads mutate it
  // in place so live requests see the new computer set without a restart.
  let reloadTimer: NodeJS.Timeout | undefined;
  let reloading = false;
  let reloadAgain = false;
  const reload = async (): Promise<void> => {
    if (reloading) { reloadAgain = true; return; }
    reloading = true;
    try {
      const next = await loadComputers();
      const names = new Set(next.map(computer => computer.name));
      const removed = computers.filter(computer => !computer.local && !names.has(computer.name));
      computers.splice(0, computers.length, ...next);
      hub.setComputers(computers);
      await Promise.all(removed.map(closeMasters));
    } catch {
      // A malformed file leaves the current computers in place; the next write retries.
    } finally {
      reloading = false;
      if (reloadAgain) { reloadAgain = false; void reload(); }
    }
  };
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(bridgeRoot(), (_event, filename) => {
      if (filename && filename !== "desktop.yaml" && filename !== "hooks.yaml") return;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { reloadTimer = undefined; void reload(); }, 500);
    });
  } catch {
    // The bridge directory may not exist yet; link/revoke creates it.
  }

  const stop = async () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    if (watcher) watcher.close();
    hub.stop();
    await server.close();
    await closeAllMasters(computers, 3_000);
    process.exit(0);
  };
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
