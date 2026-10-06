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
export type FindingQualityReason = "too_short" | "boilerplate_phrase" | "transient_tool_error" | "diff_scrape_template" | "prompt_template_echo" | "non_prose_fragment";
/**
 * Classify a finding candidate. Returns null when the text is worth keeping.
 * Accepts raw capture text, a `- ` bullet from FINDINGS.md, or a `- [date] ` queue line.
 */
export declare function findingQualityReason(raw: string): FindingQualityReason | null;
/** True when a finding line is junk: boilerplate, machine noise, or a non-prose fragment. */
export declare function isLowValueFinding(raw: string): boolean;
