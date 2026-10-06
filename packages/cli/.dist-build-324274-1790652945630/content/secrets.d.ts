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
export declare function looksLikePlaceholderSecret(value: string): boolean;
/**
 * Scan text for secrets and PII patterns. Returns the type of secret found, or null if clean.
 */
export declare function scanForSecrets(text: string): string | null;
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
export declare function redactSecretsForLog(text: string): string;
