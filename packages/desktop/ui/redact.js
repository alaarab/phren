const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
// Well-known token shapes that can sit inside ordinary text (a pasted command,
// an error message): GitHub, OpenAI/Anthropic-style, Slack, AWS access keys.
const TOKENS = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;

/** The existing trace redactor, also used for notification text. */
export function redactString(value) {
  return value.replace(PRIVATE_KEY, "[redacted]").replace(BEARER, "Bearer [redacted]").replace(TOKENS, "[redacted]");
}

// ---- notification text -----------------------------------------------------
// Patterns run over a bounded window (so a long reply can't stall the renderer),
// and the result is shortened only AFTER redaction, so a cut can't split a
// secret out of its match.
const SCAN_MAX = 4000;
export const NOTICE_MAX = 400;

// More prefixed shapes: GitLab, npm, Stripe, Google, Hugging Face, DigitalOcean, JWTs.
const MORE_TOKENS = /\b(?:glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35}|hf_[A-Za-z0-9]{30,}|do[opr]_v1_[A-Za-z0-9]{32,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;
// Authorization headers of any scheme (Basic, Token, AWS4-HMAC-SHA256...): the scheme's credential
// and any further "Name=value" parameters (Credential=..., SignedHeaders=..., Signature=...).
const AUTHORIZATION = /\b((?:Proxy-)?Authorization\s*:\s*)[A-Za-z0-9-]+\s+[^\s,]+(?:,\s*[A-Za-z][A-Za-z-]*=[^\s,]+)*/gi;
// Signed-URL and connection-string parameters that are credentials themselves.
const SIGNED_PARAMS = /([?&;](?:sig|signature|x-amz-signature|x-amz-credential|x-goog-signature|sv_sig|token|access_token|code)=)[^&\s;#]+/gi;
// user:password@ in any URL (https://, redis://, postgres://...).
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@:]{0,200}:[^\s/@]{0,200}@/gi;
// Credential-named keys: a separate word (password, DB_PASSWORD, api-key, "api_key")
// or a known camelCase name. CancellationToken and the like are code, not secrets.
const KEY_WORDS = "password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key|client[_-]?secret|credentials?";
const CAMEL_KEYS = "accessToken|refreshToken|authToken|idToken|apiKey|apiToken|clientSecret|secretKey|privateKey|accountKey|sharedAccessKey";
const ASSIGNMENT = new RegExp(
  // The keyword is a whole word of the key (DB_PASSWORD, SECRET_KEY, api-key) or a known camelCase name.
  `((?<![A-Za-z0-9_.-])["']?(?:(?:[A-Za-z0-9]+[_. -])*(?:${KEY_WORDS})(?:[_.-][A-Za-z0-9]+)*|${CAMEL_KEYS})["']?\\s{0,4}[=:]\\s{0,4})` +
  `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,;}\\])"']+)`, "gi");
// Upper-case environment names ending in a credential word (PGPASSWORD, MYSQL_PWD): case-sensitive,
// so code identifiers such as CancellationToken don't match.
const ENV_ASSIGNMENT = /((?<![A-Za-z0-9_])[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN)\s{0,4}[=:]\s{0,4})("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\])"']+)/g;
// Long unprefixed runs, judged by looksSecret.
const LONG_RUN = /(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/-]{32,}={0,2}(?![A-Za-z0-9_+/=-])/g;

/** A git object id (40 or 64 lowercase hex) is a reference people need, not a secret. */
const isObjectId = (run) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(run);
/** A word-like path segment: lowercase, kebab or CamelCase words (no runs of capitals, as random keys have). */
const wordSegment = (part) => /^[A-Za-z][a-z0-9_-]*(?:[A-Z][a-z0-9_-]+)*[A-Z]?$/.test(part);
/** A file path: every segment reads like a name (a rooted path's first segment is empty). */
const isPath = (run) => run.includes("/") && run.replace(/^[/~]+/, "").split("/").every(wordSegment);

function looksSecret(run) {
  if (isObjectId(run) || isPath(run)) return false;
  if (/^[0-9a-fA-F]+$/.test(run)) return true; // other long hex: keys and digests of secrets
  // Mixed case and digits, as random keys are; words and identifiers aren't.
  return run.length >= 40 && /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);
}

/** Redact the whole notification text, cut to what a notification shows. */
export function redactNotice(value) {
  const text = value.length > SCAN_MAX ? value.slice(0, SCAN_MAX) : value;
  const redacted = redactString(text)
    .replace(MORE_TOKENS, "[redacted]")
    .replace(AUTHORIZATION, "$1[redacted]")
    .replace(SIGNED_PARAMS, "$1[redacted]")
    .replace(URL_CREDENTIALS, "$1[redacted]@")
    .replace(ASSIGNMENT, "$1[redacted]")
    .replace(ENV_ASSIGNMENT, "$1[redacted]")
    .replace(LONG_RUN, (run) => (looksSecret(run) ? "[redacted]" : run));
  if (redacted.length <= NOTICE_MAX && value.length <= SCAN_MAX) return redacted;
  // Shorten after redacting, and never end inside a word that could be the start of a secret.
  return `${redacted.slice(0, NOTICE_MAX).replace(/\S*$/, "")}…`;
}
