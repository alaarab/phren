#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { apnsSender } from "./apns.js";
import { createRelayServer } from "./index.js";
import { Relay } from "./relay.js";

/** Runs the relay from its environment:
 *   PHREN_RELAY_SECRET   32+ random bytes, hex or base64 (the only state)
 *   APNS_KEY_FILE        the .p8 from the Apple developer account (or APNS_KEY, its contents)
 *   APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC (the app's bundle id, com.phren.ios)
 *   PORT                 default 8787, listening on 127.0.0.1 behind the proxy */
function required(name: string): string {
  const value = process.env[name];
  if (!value) { console.error(`${name} is not set.`); process.exit(1); }
  return value;
}
const raw = required("PHREN_RELAY_SECRET");
const secret = /^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
const relay = new Relay(secret);
// The key comes from a file (a host) or straight from a secret (Cloud Run's APNS_KEY).
const privateKey = process.env.APNS_KEY ?? readFileSync(required("APNS_KEY_FILE"), "utf8");
const send = apnsSender({ keyId: required("APNS_KEY_ID"), teamId: required("APNS_TEAM_ID"),
  topic: process.env.APNS_TOPIC ?? "com.phren.ios", privateKey });
const port = Number(process.env.PORT ?? 8787);
createRelayServer({ relay, send }).listen(port, process.env.HOST ?? "127.0.0.1", () => {
  console.log(`phren push relay listening on ${process.env.HOST ?? "127.0.0.1"}:${port}`);
});
