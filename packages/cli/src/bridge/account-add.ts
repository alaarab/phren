import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { homeDir } from "../home-paths.js";
import { badAccountSlug, suggestAccountSlug } from "./claude-account-setup.js";
import { claudeAuthStatus, claudeHome, claudeHomes, clearAccountCaches, DEFAULT_ACCOUNT, isAccountSlug, type AuthStatus, type ClaudeHome } from "./claude-accounts.js";
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

/**
 * `claude /login` under the slot's own home, never the pane shell's: a shell that exports CLAUDE_CONFIG_DIR
 * (`~/.claude-work` from the owner's profile) would otherwise sign in that account while the Hook checks this
 * one. The default home the Hook found without CLAUDE_CONFIG_DIR runs with it removed (Claude's own default,
 * where its keychain item lives); every home the Hook found through it, the default one included and even when
 * that is ~/.claude, runs with it set to the home, as the Hook's own status check does. `env` runs a program,
 * not the shell's alias for `claude` (an old local install's `alias claude=~/.claude/local/claude`), so the
 * command names the `claude` the Hook finds on its PATH, when it finds one.
 */
export function loginCommand(home: ClaudeHome, claude = claudeBinary()): string {
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const configured = !home.isDefault || home.configFile === path.join(home.dir, ".claude.json");
  const program = claude ? quote(claude) : "claude";
  return configured ? `env CLAUDE_CONFIG_DIR=${quote(home.dir)} ${program} /login` : `env -u CLAUDE_CONFIG_DIR ${program} /login`;
}

/** The `claude` executable on the Hook's PATH, else Claude's own local install, else undefined. */
function claudeBinary(): string | undefined {
  const candidates = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(directory => path.join(directory, "claude")),
    path.join(homeDir(), ".claude", "local", "claude")];
  return candidates.find(file => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } });
}

/** A sign-in pane blocks another for its slot this long: it stays open as a Claude session once signed in. */
const SIGN_IN_PANE_MS = 10 * 60_000;

/**
 * Sign in an account slot that exists but is signed out, from the phone: opens a pane running `claude /login`
 * for it, as adding an account does, for the owner to finish. A slot already signed in is refused; one whose
 * state Claude did not report opens anyway (logging in again is harmless). `sign-in-status` answers whether
 * it is signed in now: asked afresh while a sign-in pane for the slot is open (the owner is finishing the
 * login there, so a cached answer would lag it), else at most half a minute old when signed out.
 */
export async function signInClaudeAccount(input: unknown, server: string,
  auth: (home: ClaudeHome, options: { fresh: boolean }) => Promise<AuthStatus> = (home, { fresh }) => { if (fresh) clearAccountCaches(); return claudeAuthStatus(home); }): Promise<Json> {
  const { slug, mode } = accountSignInSchema.parse(input);
  const home = existingSlot(slug);
  const key = `${bridgeRoot()}\0sign-in\0${home.id}`;
  const pending = pendingPanes.get(key);
  const status = await auth(home, { fresh: mode === "sign-in-status" && !!pending && Date.now() - (pending.at ?? 0) < SIGN_IN_PANE_MS });
  // Signed in: the pane that did it is a Claude session now, not a sign-in under way.
  if (status.signedIn) pendingPanes.delete(key);
  if (mode === "sign-in-status") return { slug: home.id, signedIn: status.signedIn, ...(status.unknown ? { unknown: true } : {}), ...(status.plan ? { plan: status.plan } : {}) };
  if (status.signedIn) throw new BridgeError(409, `Claude account "${home.id}" is already signed in.`, { code: "signed-in" });
  if (adding.has(key)) throw new BridgeError(409, "That Claude account is already being signed in.");
  adding.add(key);
  try {
    if (pending && Date.now() - (pending.at ?? 0) >= SIGN_IN_PANE_MS) pendingPanes.delete(key);
    const pane = await openPane(server, key, `Sign in to Claude account ${home.id}`, "That Claude account is already being signed in in an open pane.");
    await terminalProvider().shellCommand!(server, pane.pane, loginCommand(home));
    return { target: { server, workspace: pane.workspace, tab: pane.tab, pane: pane.pane, source: "claude" }, terminalOnly: true, slug: home.id };
  } finally { adding.delete(key); }
}

/**
 * A new pane for an interactive account step, refused while the last one for `key` is still open. The pane is
 * the one the terminal says it created; a terminal that doesn't say is diffed before and after, one account
 * pane at a time per terminal server, so two sign-ins at once (different slots) never see each other's pane.
 */
async function openPane(server: string, key: string, label: string, busy: string) {
  const terminal = terminalProvider();
  if (!terminal.shellCommand) throw new BridgeError(503, "This terminal cannot open an interactive account login.");
  return oneAtATime(server, async () => {
    const pending = pendingPanes.get(key);
    if (pending && (await terminal.listPanes(pending.server)).some(pane => pane.pane === pending.pane)) throw new BridgeError(409, busy);
    pendingPanes.delete(key);
    const before = new Set((await terminal.listPanes(server)).map(pane => pane.pane));
    const named = await terminal.create(server, { label, cwd: homeDir() });
    let created: { workspace: string; tab: string; pane: string };
    if (named) created = named;
    else {
      const found = (await terminal.listPanes(server)).filter(pane => !before.has(pane.pane));
      if (found.length !== 1) throw new BridgeError(409, "The new account pane could not be identified safely.");
      created = found[0];
    }
    pendingPanes.set(key, { server, pane: created.pane, at: Date.now() });
    return { server, workspace: created.workspace, tab: created.tab, pane: created.pane };
  });
}

/** Account panes being opened, by terminal server: the next waits for the last. */
const opening = new Map<string, Promise<unknown>>();
function oneAtATime<T>(server: string, work: () => Promise<T>): Promise<T> {
  const result = (opening.get(server) ?? Promise.resolve()).then(work);
  const tail = result.catch(() => undefined);
  opening.set(server, tail);
  void tail.then(() => { if (opening.get(server) === tail) opening.delete(server); });
  return result;
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
