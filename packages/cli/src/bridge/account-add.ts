import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { homeDir } from "../home-paths.js";
import { claudeHomes } from "./claude-accounts.js";
import { BridgeError, bridgeRoot, type Json } from "./protocol.js";
import { terminalProvider } from "./terminal.js";

export const accountAddSchema = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,32}$/) }).strict();
const adding = new Set<string>();
const pendingPanes = new Map<string, { server: string; pane: string }>();
/** Open a shell for the owner to complete the existing interactive flow. */
export async function addClaudeAccount(input: unknown, server: string): Promise<Json> {
  const { slug } = accountAddSchema.parse(input);
  const key = `${bridgeRoot()}\0${slug}`;
  if (adding.has(key) || claudeHomes().some(home => home.id === slug) || existsSync(path.join(homeDir(), `.claude-${slug}`))) throw new BridgeError(409, "That Claude account already exists or is being added.");
  adding.add(key);
  try {
    const terminal = terminalProvider();
    if (!terminal.shellCommand) throw new BridgeError(503, "This terminal cannot open an interactive account login.");
    const pending = pendingPanes.get(key);
    if (pending && (await terminal.listPanes(pending.server)).some(pane => pane.pane === pending.pane)) throw new BridgeError(409, "That Claude account is already being added in an open pane.");
    pendingPanes.delete(key);
    const before = new Set((await terminal.listPanes(server)).map(pane => pane.pane));
    await terminal.create(server, { label: `Add Claude account ${slug}`, cwd: homeDir() });
    const created = (await terminal.listPanes(server)).filter(pane => !before.has(pane.pane));
    if (created.length !== 1) throw new BridgeError(409, "The new account pane could not be identified safely.");
    const pane = created[0];
    pendingPanes.set(key, { server, pane: pane.pane });
    await terminal.shellCommand(server, pane.pane, `phren bridge accounts add '${slug}'`);
    return { target: { server, workspace: pane.workspace, tab: pane.tab, pane: pane.pane, source: "claude" }, terminalOnly: true };
  } finally { adding.delete(key); }
}
