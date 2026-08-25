/**
 * Credential detection for anything phren is about to persist or hand back to
 * an agent.
 *
 * Deliberately a dependency-free leaf module. It used to live inside
 * content/dedup.ts, whose import graph pulls in data/access, finding/lifecycle
 * and phren-core — far too heavy for hooks.ts, which runs in a subprocess on
 * every PostToolUse and is explicitly budgeted for cold-start time. dedup.ts
 * re-exports everything here, so existing importers are unchanged.
 */

/**
 * Whether a value captured by one of the *name-based* rules below is obviously
 * a placeholder rather than a credential.
 *
 * This exists to raise precision, not recall. A hit here does not scrub the
 * finding — it silently throws the whole finding away, so a false positive
 * costs the user real knowledge and leaves no trace that it happened. The
 * name-based rules are the ones that fire on shape alone ("something called
 * token was assigned something long"), and source code is full of exactly that
 * shape with nothing secret in it: this store already contains an
 * auto-captured finding quoting `_authToken = '__PHRE…'` from phren's own
 * web UI, which is a template marker, not a credential.
 *
 * Only whole values count as placeholders. `TESTONLYFAKEKEY0000001` contains
 * "FAKE" but is not itself a placeholder word, so it is still treated as a
 * secret. The high-confidence rules (AKIA…, ghp_…, sk-ant-…, PEM headers)
 * never consult this — those shapes are unambiguous and a documented example
 * key is still a key.
 */
export function looksLikePlaceholderSecret(value: string): boolean {
  const v = value.trim().replace(/^['"`]+|['"`]+$/g, "").trim();
  if (!v) return true;
  // Template syntax: <TOKEN>, {{token}}, ${TOKEN}, %TOKEN%, __TOKEN__, and
  // bare shell interpolation ($TOKEN), which is how captured command output
  // usually spells a credential it did not actually expand.
  if (/^(?:<[^<>]*>|\{\{[^{}]*\}\}|\$\{[^{}]*\}|%[^%]*%|__.+__|\$[A-Za-z_][A-Za-z0-9_]*)$/.test(v)) return true;
  // Masked or elided values: ****, xxxxxxxx, ......, 00000000.
  if (/^(?:[*.]{3,}|[xX]{4,}|0{8,})$/.test(v)) return true;
  // SCREAMING_SNAKE identifiers — YOUR_API_KEY, PHREN_AUTH_TOKEN. Real tokens
  // are mixed-case or mixed-charset; an all-caps underscore identifier is a
  // variable name standing in for one.
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v)) return true;
  // Whole-value placeholder words, and `your_*` / `my_*` template names.
  if (/^(?:changeme|change[_-]?me|placeholder|redacted|example|dummy|sample|fake|todo|fixme|none|null|undefined|secret|pass|passwd|password|token|apikey|api[_-]?key)$/i.test(v)) return true;
  if (/^(?:your|my|the|some)[_-][a-z0-9_-]*$/i.test(v)) return true;
  if (/[_-]?goes[_-]?here$/i.test(v)) return true;
  return false;
}

/**
 * Return the first non-placeholder value captured by `re` (capture group 1),
 * or null when every match looks like a template marker.
 */
function firstRealSecretValue(text: string, re: RegExp): string | null {
  for (const match of text.matchAll(re)) {
    const value = match[1];
    if (value && !looksLikePlaceholderSecret(value)) return value;
  }
  return null;
}

/** Something called api_key/secret/token/password assigned a long literal. */
const NAMED_SECRET_RE = /['"]?(?:api_?key|secret|token|password)['"]?\s*[=:]\s*['"]?([a-zA-Z0-9_\-.]{20,})/gi;
/** `Authorization: Bearer <token>` as captured from command output or code. */
const BEARER_RE = /\bauthorization['"]?\s*[=:]\s*['"]?\s*bearer\s+([A-Za-z0-9\-._~+/]{20,}=*)/gi;
/** npm/yarn registry auth line, e.g. `//registry.example.com/:_authToken=…`. */
const NPM_AUTH_TOKEN_RE = /_auth(?:Token)?\s*=\s*['"]?([A-Za-z0-9\-._~+/]{16,}=*)/gi;
/** Any URL carrying inline credentials, not just the four db schemes below. */
const URL_CREDENTIALS_RE = /\bhttps?:\/\/[^/\s:@]+:([^/\s:@]+)@[^\s]+/gi;

/**
 * Scan text for secrets and PII patterns. Returns the type of secret found, or null if clean.
 */
export function scanForSecrets(text: string): string | null {
  // AWS Access Key
  if (/AKIA[0-9A-Z]{16}/.test(text)) return 'AWS access key';
  // AWS Secret Access Key (variable assignment pattern)
  if (/(?:aws[_-]?secret|AWS_SECRET)[_-]?(?:access[_-]?)?key[_-]?(?:id)?['":\s]+[A-Za-z0-9/+=]{40}/i.test(text)) return 'AWS secret access key';
  // JWT token
  if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text)) return 'JWT token';
  // Fixed-prefix, fixed-shape credentials. These sit above the generic base64
  // rule below so the rejection message names the actual credential — "Slack
  // webhook URL" tells the user what to strip, "long base64 secret" does not.
  // GitHub fine-grained PAT: different prefix and length from the classic
  // ghp_ form, so none of the existing rules saw it.
  if (/github_pat_[A-Za-z0-9_]{22,}/.test(text)) return 'GitHub fine-grained token';
  // Google / Firebase API key. Fixed prefix, fixed length, no FP surface.
  if (/\bAIza[0-9A-Za-z_-]{35}\b/.test(text)) return 'Google API key';
  // Slack incoming-webhook URL — possession of the URL is the credential.
  if (/https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/.test(text)) return 'Slack webhook URL';
  // Long base64-encoded secret-like blob (requires base64 chars including +/= and must not be
  // a plain hex digest like a git commit SHA — 40-char lowercase hex is explicitly exempt).
  // Also requires a digit: 40 random base64 chars lack one ~0.1% of the time, while
  // slash-joined camelCase identifier chains ("addFooToBar/addFoosToBar/upsertBaz") never
  // have one — that prose shape was being rejected as a credential.
  if (!/^[0-9a-f]{40}$/.test(text) && /(?=[A-Za-z0-9+/]*[+/])(?=[A-Za-z+/]*[0-9])[A-Za-z0-9+/]{40,}={0,2}/.test(text.replace(/[0-9a-f]{40}/g, ""))) return 'long base64 secret';
  // Connection string with credentials
  if (/(mongodb|postgres|mysql|redis):\/\/[^@\s]+:[^@\s]+@/i.test(text)) return 'connection string with credentials';
  // Private key PEM block. The alternation used to be RSA|EC|OPENSSH only,
  // which misses the most common header of all — PKCS#8 keys are written as a
  // bare `-----BEGIN PRIVATE KEY-----`, and that is what `openssl genpkey`,
  // every GCP service-account .pem and most Java tooling emit.
  if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text)) return 'SSH private key';
  // Anthropic API key
  if (/sk-ant-api\d{2}-[A-Za-z0-9_\-]{10,}/.test(text)) return 'Anthropic API key';
  // OpenAI API key
  if (/sk-proj-[A-Za-z0-9_\-]{30,}/.test(text)) return 'OpenAI API key';
  // GitHub PAT classic
  if (/ghp_[A-Za-z0-9]{36}/.test(text)) return 'GitHub personal access token';
  // GitHub OAuth token
  if (/gho_[A-Za-z0-9]{36}/.test(text)) return 'GitHub OAuth token';
  // GitHub tokens (classic, OAuth, user, org, server)
  if (/gh[pousr]_[A-Za-z0-9]{36}/.test(text)) return 'GitHub token';
  // Slack bot token
  if (/xoxb-[0-9]+-[A-Za-z0-9-]+/.test(text)) return 'Slack bot token';
  // Slack user token
  if (/xoxp-[0-9]+-[A-Za-z0-9-]+/.test(text)) return 'Slack user token';
  // Stripe secret key
  if (/sk_live_[A-Za-z0-9]{24,}/.test(text)) return 'Stripe secret key';
  // Stripe publishable key
  if (/pk_live_[A-Za-z0-9]{24,}/.test(text)) return 'Stripe publishable key';
  // npm access token
  if (/npm_[A-Za-z0-9]{36}/.test(text)) return 'npm access token';
  // GCP service account
  if (/"private_key_id"\s*:\s*"[^"]{20,}"/.test(text)) return 'GCP service account key';

  // ── Name-based rules ──────────────────────────────────────────────────────
  // Below here a match is inferred from a *name* plus a long value, not from
  // an unambiguous credential shape, so each one skips values that are plainly
  // template markers. See looksLikePlaceholderSecret for why that matters:
  // a hit discards the user's finding outright rather than redacting it.

  // Any URL carrying inline credentials. The connection-string rule above only
  // covers mongodb/postgres/mysql/redis, so `https://user:pat@github.com/…` —
  // the form that actually shows up in captured command output and in remote
  // URLs — went straight through.
  if (firstRealSecretValue(text, URL_CREDENTIALS_RE)) return 'URL with embedded credentials';
  // `Authorization: Bearer …`, as copied out of curl invocations and logs.
  if (firstRealSecretValue(text, BEARER_RE)) return 'bearer token';
  // npm/yarn registry auth line. `npm_…` tokens are caught above, but a
  // self-hosted or GitHub Packages registry uses an arbitrary token string.
  if (firstRealSecretValue(text, NPM_AUTH_TOKEN_RE)) return 'registry auth token';
  // Generic API key (only when the variable name suggests it).
  if (firstRealSecretValue(text, NAMED_SECRET_RE)) return 'API key or secret';
  return null;
}
/**
 * Make a diagnostic string safe to write to a log or hand back to an agent.
 *
 * Custom hook failures compose their message from the hook's own command plus
 * the child's stderr — `${event}: ${hook.command}: ${errorMessage(err)}` — and
 * that string goes to two places: `.runtime/hook-errors.log`, and the MCP
 * response, which lands in the agent's context and its transcript. Hook
 * commands legitimately carry inline credentials (`curl -H "Authorization:
 * Bearer …"` passes validateCustomHookCommand — it contains none of the
 * blocked shell metacharacters), and a failing child prints whatever it likes
 * to stderr.
 *
 * Fails closed rather than trying to excise the secret in place: if the text
 * trips the detector at all, none of it is emitted. A partially-redacted
 * diagnostic is worth less than an honest statement that it was withheld, and
 * substring surgery on an unknown format is how redactors leak.
 */
export function redactSecretsForLog(text: string): string {
  const secretType = scanForSecrets(text);
  if (!secretType) return text;
  return `[redacted: withheld, contained ${secretType}]`;
}
