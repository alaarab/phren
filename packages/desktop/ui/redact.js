const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
// Well-known token shapes that can sit inside ordinary text (a pasted command,
// an error message): GitHub, OpenAI/Anthropic-style, Slack, AWS access keys.
const TOKENS = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;
const ASSIGNMENT = /\b((?:password|passphrase|secret|token|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const LONG_SECRET = /(?<![A-Za-z0-9_+/-])(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9_+/-]{40,}={0,2})(?![A-Za-z0-9_+/-])/g;

/** The existing trace redactor, also used for notification text. */
export function redactString(value) {
  return value.replace(PRIVATE_KEY, "[redacted]").replace(BEARER, "Bearer [redacted]").replace(TOKENS, "[redacted]");
}

/** Redact the whole notification before Electron truncates it. */
export function redactNotice(value) {
  return redactString(value).replace(ASSIGNMENT, "$1[redacted]").replace(LONG_SECRET, "[redacted]");
}
