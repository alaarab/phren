const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
// Well-known token shapes that can sit inside ordinary text (a pasted command,
// an error message): GitHub, OpenAI/Anthropic-style, Slack, AWS access keys.
const TOKENS = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;
// More prefixed shapes for notification text: GitLab, npm, Stripe, Google, Hugging Face, JWTs.
const MORE_TOKENS = /\b(?:glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35}|hf_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
// user:password@ in any URL (https://, redis://, postgres://...).
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi;
// key = value and "key": "value" for credential-named keys, prefixed names (DB_PASSWORD) included.
const ASSIGNMENT = /((?<![A-Za-z0-9])["']?[A-Za-z0-9_.-]*?(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}\])"']+)/gi;
// Long unprefixed runs, judged by looksSecret.
const LONG_RUN = /(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/-]{32,}={0,2}(?![A-Za-z0-9_+/=-])/g;

/** The existing trace redactor, also used for notification text. */
export function redactString(value) {
  return value.replace(PRIVATE_KEY, "[redacted]").replace(BEARER, "Bearer [redacted]").replace(TOKENS, "[redacted]");
}

/** A git object id (40 or 64 lowercase hex) is a reference people need, not a secret. */
const isObjectId = (run) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(run);
/** A word-like path segment: lowercase, kebab or CamelCase words (no runs of capitals, as random keys have). */
const wordSegment = (part) => /^[A-Za-z][a-z0-9_-]*(?:[A-Z][a-z0-9_-]+)*[A-Z]?$/.test(part);
/** A file path: rooted, or every segment reads like a name. */
const isPath = (run) => /^[/~]/.test(run) || (run.includes("/") && run.split("/").every(wordSegment));

function looksSecret(run) {
  if (isObjectId(run) || isPath(run)) return false;
  if (/^[0-9a-fA-F]+$/.test(run)) return true; // other long hex: keys and digests of secrets
  // Mixed case and digits, as random keys are; words and identifiers aren't.
  return run.length >= 40 && /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);
}

/** Redact the whole notification before Electron truncates it. */
export function redactNotice(value) {
  return redactString(value)
    .replace(MORE_TOKENS, "[redacted]")
    .replace(URL_CREDENTIALS, "$1[redacted]@")
    .replace(ASSIGNMENT, "$1[redacted]")
    .replace(LONG_RUN, (run) => (looksSecret(run) ? "[redacted]" : run));
}
