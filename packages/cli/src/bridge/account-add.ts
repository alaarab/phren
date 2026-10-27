import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { homeDir } from "../home-paths.js";
import { badAccountSlug, suggestAccountSlug } from "./claude-account-setup.js";
import { claudeAuthStatus, claudeHome, claudeHomes, DEFAULT_ACCOUNT, isAccountSlug, type AuthStatus, type ClaudeHome } from "./claude-accounts.js";
import { BridgeError, bridgeRoot, type Json } from "./protocol.js";
import { terminalProvider } from "./terminal.js";

export const accountAddSchema = z.object({ slug: z.string().max(256), email: z.string().max(254).optional() }).strict();
/** An existing slot's sign-in: `sign-in` opens `claude /login` for it, `sign-in-status` says whether it is signed in. */
export const accountSignInSchema = z.object({ slug: z.string().max(256), mode: z.enum(["sign-in", "sign-in-status"]) }).strict();

/** The slot `slug` names, or why there is none. */
function existingSlot(slug: string): ClaudeHome {
  if (!isAccountSlug(slug)) throw new BridgeError(400, badAccountSlug(slug), { suggestedSlug: suggestAccountSlug(slug) });
  const home = claudeHome(slug);
  if (!home) throw new BridgeError(404, `There is no Claude account "${slug}" on this computer. Add it first.`);
  return home;
}

/** `claude /login` under the slot's own home: CLAUDE_CONFIG_DIR for an added account, and for the default one
 * when the Hook's is not ~/.claude (set where the Hook started, not in the pane's shell). */
function loginCommand(home: ClaudeHome): string {
  if (home.isDefault && home.dir === path.join(homeDir(), ".claude")) return "claude /login";
  return `CLAUDE_CONFIG_DIR='${home.dir.replace(/'/g, "'\\''")}' claude /login`;
}

/** A sign-in pane blocks another for its slot this long: it stays open as a Claude session once signed in. */
const SIGN_IN_PANE_MS = 10 * 60_000;

/**
 * Sign in an account slot that exists but is signed out, from the phone: opens a pane running `claude /login`
 * for it, as adding an account does, for the owner to finish. A slot already signed in is refused; one whose
 * state Claude did not report opens anyway (logging in again is harmless). `sign-in-status` answers whether
 * it is signed in now (a signed-out answer is at most half a minute old).
 */
export async function signInClaudeAccount(input: unknown, server: string, auth: (home: ClaudeHome) => Promise<AuthStatus> = home => claudeAuthStatus(home)): Promise<Json> {
  const { slug, mode } = accountSignInSchema.parse(input);
  const home = existingSlot(slug);
  const status = await auth(home);
  const key = `${bridgeRoot()}\0sign-in\0${home.id}`;
  // Signed in: the pane that did it is a Claude session now, not a sign-in under way.
  if (status.signedIn) pendingPanes.delete(key);
  if (mode === "sign-in-status") return { slug: home.id, signedIn: status.signedIn, ...(status.unknown ? { unknown: true } : {}), ...(status.plan ? { plan: status.plan } : {}) };
  if (status.signedIn) throw new BridgeError(409, `Claude account "${home.id}" is already signed in.`, { code: "signed-in" });
  if (adding.has(key)) throw new BridgeError(409, "That Claude account is already being signed in.");
  adding.add(key);
  try {
    const pending = pendingPanes.get(key);
    if (pending && Date.now() - (pending.at ?? 0) >= SIGN_IN_PANE_MS) pendingPanes.delete(key);
    const pane = await openPane(server, key, `Sign in to Claude account ${home.id}`, "That Claude account is already being signed in in an open pane.");
    await terminalProvider().shellCommand!(server, pane.pane, loginCommand(home));
    return { target: { server, workspace: pane.workspace, tab: pane.tab, pane: pane.pane, source: "claude" }, terminalOnly: true, slug: home.id };
  } finally { adding.delete(key); }
}

/** A new pane for an interactive account step, refused while the last one for `key` is still open. */
async function openPane(server: string, key: string, label: string, busy: string) {
  const terminal = terminalProvider();
  if (!terminal.shellCommand) throw new BridgeError(503, "This terminal cannot open an interactive account login.");
  const pending = pendingPanes.get(key);
  if (pending && (await terminal.listPanes(pending.server)).some(pane => pane.pane === pending.pane)) throw new BridgeError(409, busy);
  pendingPanes.delete(key);
  const before = new Set((await terminal.listPanes(server)).map(pane => pane.pane));
  await terminal.create(server, { label, cwd: homeDir() });
  const created = (await terminal.listPanes(server)).filter(pane => !before.has(pane.pane));
  if (created.length !== 1) throw new BridgeError(409, "The new account pane could not be identified safely.");
  pendingPanes.set(key, { server, pane: created[0].pane, at: Date.now() });
  return created[0];
}
const adding = new Set<string>();
const pendingPanes = new Map<string, { server: string; pane: string; at?: number }>();
/** Open a shell for the owner to complete the existing interactive flow. */
export async function addClaudeAccount(input: unknown, server: string): Promise<Json> {
  const { slug, email } = accountAddSchema.parse(input);
  // Answered with a name that would work, so the phone can offer it rather than a bare refusal.
  if (slug === DEFAULT_ACCOUNT || !isAccountSlug(slug)) throw new BridgeError(400, badAccountSlug(slug, email), { suggestedSlug: suggestAccountSlug(slug, email) });
  const key = `${bridgeRoot()}\0${slug}`;
  if (adding.has(key) || claudeHomes().some(home => home.id === slug) || existsSync(path.join(homeDir(), `.claude-${slug}`))) throw new BridgeError(409, "That Claude account already exists or is being added.");
  adding.add(key);
  try {
    const pane = await openPane(server, key, `Add Claude account ${slug}`, "That Claude account is already being added in an open pane.");
    await terminalProvider().shellCommand!(server, pane.pane, `phren bridge accounts add -- '${slug}'`);
    return { target: { server, workspace: pane.workspace, tab: pane.tab, pane: pane.pane, source: "claude" }, terminalOnly: true };
  } finally { adding.delete(key); }
}
