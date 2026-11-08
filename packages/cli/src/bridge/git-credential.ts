import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { atomic, bridgeRoot } from "./protocol.js";
import { detectHost } from "./git-hosts.js";
import { resolveHostToken } from "./git-host-auth.js";

/**
 * Git and API credentials for a dispatched agent in a gitboy checkout. The
 * agent gets the computer's stored `phren-agent` token, never the caller's:
 * `resolveHostToken(..., { env: {}, cli: false })` reads only the Hook's
 * `git-hosts.json`. Git uses it through a credential helper installed beside
 * the sudo askpass, so the token never appears in argv or a remote URL.
 */

export const GIT_CREDENTIAL_FILE = "git-credential";
export const gitCredentialPath = () => path.join(bridgeRoot(), GIT_CREDENTIAL_FILE);

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The helper script: the node that installed the Hook, the current bundle, and the domain git appends its operation to. */
export function gitCredentialScript(node: string, bundle: string): string {
  return `#!/bin/sh\n# Installed by Phren Hook: git reads the stored gitboy token from the Hook.\n`
    + `unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH\n`
    + `${quote(node)} ${quote(bundle)} git-host credential "$@"\n`;
}

export async function installGitCredential(node: string, bundle: string): Promise<void> {
  await atomic(gitCredentialPath(), gitCredentialScript(node, bundle), 0o700);
}
export async function removeGitCredential(): Promise<void> { await unlink(gitCredentialPath()).catch(() => undefined); }

/** Install the helper on first use, for a Hook whose installer predates it. */
async function ensureGitCredential(): Promise<string | undefined> {
  const script = gitCredentialPath();
  if (existsSync(script)) return script;
  const bundle = process.argv[1];
  if (!bundle) return undefined;
  await atomic(script, gitCredentialScript(process.execPath, path.resolve(bundle)), 0o700).catch(() => undefined);
  return existsSync(script) ? script : undefined;
}

/**
 * Environment for a worker started in `cwd`. A gitboy checkout gets the stored
 * token as GITBOY_HOST/GITBOY_TOKEN (for its API) and a credential helper that
 * answers git with the same token. An empty `credential.helper` resets any
 * helper from the agent's own config, so no other token can win.
 */
export async function gitHostLaunchEnv(cwd: string): Promise<Record<string, string> | undefined> {
  const host = await detectHost(cwd, "");
  if (host.kind !== "gitboy" || !host.domain) return undefined;
  const stored = await resolveHostToken("gitboy", host.domain, { env: {}, cli: false });
  // An empty token overrides any gitboy token the Hook process inherited;
  // only the stored phren-agent token is ever passed on.
  const env: Record<string, string> = { GITBOY_HOST: host.domain, GITBOY_TOKEN: stored?.token ?? "", GIT_TERMINAL_PROMPT: "0" };
  if (!stored) return env;
  const script = await ensureGitCredential();
  // The installed helper is preferred; a test or a pre-helper install can run
  // the bundle (or `phren`) directly instead.
  const helper = script ? `${quote(script)} ${quote(host.domain)}`
    : process.argv[1] ? `${quote(process.execPath)} ${quote(path.resolve(process.argv[1]))} git-host credential ${quote(host.domain)}`
      : `phren git-host credential ${quote(host.domain)}`;
  env.GIT_CONFIG_COUNT = "3";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 = "";
  env.GIT_CONFIG_KEY_1 = `credential.https://${host.domain}.helper`;
  env.GIT_CONFIG_VALUE_1 = `!${helper}`;
  env.GIT_CONFIG_KEY_2 = `credential.https://${host.domain}.username`;
  env.GIT_CONFIG_VALUE_2 = stored.user ?? "phren";
  return env;
}

/** A git credential request for `domain`, answered from the Hook's stored token only. */
export async function gitCredentialAnswer(domain: string, request: string): Promise<{ username: string; password: string } | undefined> {
  const key = domain.trim().toLowerCase().replace(/\.$/, "");
  const host = /(?:^|\n)host=(.+)/.exec(request)?.[1]?.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (!key || !host || host !== key) return undefined;
  const stored = await resolveHostToken("gitboy", key, { env: {}, cli: false });
  if (!stored) return undefined;
  return { username: stored.user ?? "phren", password: stored.token };
}
