#!/usr/bin/env node
// Phren desktop phase 0 spike: wire the modules declared in contract.ts.
import { randomBytes } from "node:crypto";
import { loadComputers } from "./hosts.js";
import { hookRequest, hookWebSocket } from "./hook-client.js";
import { createOverviewHub } from "./overview.js";
import { attachTerminal } from "./pty-bridge.js";
import { startServer } from "./server.js";

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
