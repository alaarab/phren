/**
 * Shared low-value / junk detection for finding text.
 *
 * Generalizes the "low value" filter that used to live inline in `cli/govern.ts` so that
 * every capture site agrees with the governance sweep on what counts as junk:
 *
 *   - `cli/extract.ts`         — git/GitHub mining candidates
 *   - `cli/session-tool-hook.ts` — PostToolUse tool-output scraping
 *   - `cli/govern.ts`          — surfaces junk already sitting in FINDINGS.md
 *
 * Every class below was observed polluting a real store: 56 transient shell-failure
 * captures, 22 machine-generated diff-scrape templates, and 18 non-prose fragments
 * (including phren's own prompt text captured as a finding) in a single project.
 */

/** Why a finding is not worth keeping. */
export type FindingQualityReason =
  | "too_short"
  | "boilerplate_phrase"
  | "transient_tool_error"
  | "diff_scrape_template"
  | "prompt_template_echo"
  | "non_prose_fragment";

/** Minimum useful length once bullet/date/confidence decoration is stripped. */
const MIN_FINDING_LENGTH = 16;

/** Finding type tags phren renders in front of a finding body (FINDING_TAGS in phren-core.ts). */
const FINDING_TYPE_TAG_RE = /^\[(?:decision|pitfall|pattern|bug|workaround|context)\]\s*/i;

/**
 * Placeholder wording that carries no information (the original cli/govern.ts filter).
 * Word-bounded: as a capture-time reject this must not fire on "attempt" or "template".
 */
const BOILERPLATE_PHRASE_RE = /\b(?:fixed stuff|updated things|misc|temp|wip|quick note)\b/i;

/**
 * PostToolUse Bash captures render as `[bug] command '<cmd>' failed: <first error line>`.
 * They record one machine's transient environment failure (EACCES on a managed install,
 * a missing binary, a full disk) and are worthless on any other machine or day.
 */
const TOOL_ERROR_CAPTURE_RE = /\bcommand\s+['"`][^'"`]*['"`]\s+failed\b/i;

/** Raw runtime/OS error output — only junk when nothing durable is said about it. */
const TRANSIENT_ERROR_SIGNAL_RE =
  /\b(?:EACCES|EPERM|ENOENT|EEXIST|ENOTDIR|ENOTEMPTY|EMFILE|ENOSPC|ECONNREFUSED|EADDRINUSE|ETIMEDOUT)\b|\bcommand not found\b|\bpermission denied\b|\bno such file or directory\b|npm ERR!|Traceback \(most recent call last\)/i;

/** Wording that turns a quoted error into a durable finding rather than a log line. */
const DURABLE_INSIGHT_RE =
  /\b(?:workaround|root cause|because|must|always|never|avoid|instead|caused by|fixed by|fix by|reproduce|regression|prefer)\b/i;

/**
 * Machine-generated diff scrapes: `<file>: <thing> added near "<code>"`. The template
 * names a file and a code landmark but says nothing about why either matters.
 */
const DIFF_SCRAPE_TEMPLATE_RE =
  /\b(?:error handling|try\/catch|logging|validation|null checks?|type annotations?)\s+added\s+near\b|^[\w.\-]+\.[a-z]{1,4}:\s.*\bnear\s+["'`]/i;

/**
 * Fragments of phren's own prompts and templates. The PostToolUse tag scraper matched the
 * type-tag list inside `tools/extract.ts`'s EXTRACT_PROMPT and stored the rest of the line
 * as a finding. Anything that is a slice of a phren instruction is never a finding.
 */
const PHREN_TEMPLATE_FRAGMENTS = [
  "you are extracting non-obvious engineering insights from text",
  "output only a json array of strings",
  "each string is a specific, actionable finding",
  "only extract non-obvious patterns, bugs, decisions, pitfalls, or workarounds",
  "do not extract obvious facts or things any developer would know",
  "do not extract credentials, api keys, or personal information",
  "each finding must be self-contained",
  "prefix each finding with its type in brackets: [decision], [pitfall], [pattern], [bug], or [workaround]",
  "if nothing is worth extracting, return []",
  "return only the json array, no explanation, no markdown",
].map((fragment) => fragment.toLowerCase());

/** A body that is nothing but phren's type vocabulary, e.g. ", [pitfall], [pattern], or [bug]". */
const TAG_VOCABULARY_ECHO_RE =
  /^[\s,]*(?:(?:and|or)\s+)?(?:\[(?:decision|pitfall|pattern|bug|workaround)\][\s,]*(?:(?:and|or)\s+)?){2,}$/i;

/** Delimiters that come in pairs in prose. Apostrophes are excluded — "don't" is prose. */
const DELIMITER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
];

function countChar(text: string, char: string): number {
  let count = 0;
  for (const c of text) {
    if (c === char) count++;
  }
  return count;
}

function hasUnbalancedDelimiters(text: string): boolean {
  for (const [open, close] of DELIMITER_PAIRS) {
    if (countChar(text, open) !== countChar(text, close)) return true;
  }
  return countChar(text, "`") % 2 !== 0 || countChar(text, '"') % 2 !== 0;
}

/** Strip bullet, review-queue date stamp, and confidence prefixes — decoration, not content. */
function stripFindingDecoration(raw: string): string {
  return String(raw ?? "")
    .replace(/^\s*-\s+/, "")
    .replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, "")
    .replace(/^\[confidence\s+[\d.]+\]\s*/i, "")
    .trim();
}

function normalizeForFragmentMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Classify a finding candidate. Returns null when the text is worth keeping.
 * Accepts raw capture text, a `- ` bullet from FINDINGS.md, or a `- [date] ` queue line.
 */
export function findingQualityReason(raw: string): FindingQualityReason | null {
  const body = stripFindingDecoration(raw);
  if (body.length < MIN_FINDING_LENGTH) return "too_short";
  if (BOILERPLATE_PHRASE_RE.test(body)) return "boilerplate_phrase";

  if (TOOL_ERROR_CAPTURE_RE.test(body)) return "transient_tool_error";
  if (TRANSIENT_ERROR_SIGNAL_RE.test(body) && !DURABLE_INSIGHT_RE.test(body)) return "transient_tool_error";

  // The type tag is phren's own decoration; judge prose on what follows it.
  const content = body.replace(FINDING_TYPE_TAG_RE, "").trim();

  if (DIFF_SCRAPE_TEMPLATE_RE.test(content)) return "diff_scrape_template";

  if (TAG_VOCABULARY_ECHO_RE.test(content)) return "prompt_template_echo";
  const normalized = normalizeForFragmentMatch(content);
  if (normalized.length >= 12 && PHREN_TEMPLATE_FRAGMENTS.some((fragment) => fragment.includes(normalized))) {
    return "prompt_template_echo";
  }

  if (hasUnbalancedDelimiters(content)) return "non_prose_fragment";
  if ((content.match(/[A-Za-z]{2,}/g) ?? []).length < 2) return "non_prose_fragment";

  return null;
}

/** True when a finding line is junk: boilerplate, machine noise, or a non-prose fragment. */
export function isLowValueFinding(raw: string): boolean {
  return findingQualityReason(raw) !== null;
}
