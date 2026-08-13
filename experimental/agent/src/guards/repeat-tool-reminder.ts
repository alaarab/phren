/**
 * Loop-hygiene guard: detects runs of consecutive tool calls with identical
 * canonicalized arguments and appends an escalating reminder to the tool
 * result so the model breaks out of the loop itself.
 *
 * Advisory only — it never blocks or delays a call, and a legitimately
 * repeated call just carries a note. Counting happens post-execution so
 * denied/failed calls count too: a model hammering a denied call is exactly
 * the loop worth breaking. A direct user interjection resets the chain
 * (repetition across it is not a loop).
 */

/** Consecutive-run lengths that trigger a reminder. */
export const REPEAT_THRESHOLDS = [3, 5, 8];

/** Cap on canonical arguments quoted in the detailed reminder. */
const ARGUMENTS_PREVIEW_CHARS = 500;

export interface RepeatChainState {
  key: string | null;
  count: number;
}

export function createRepeatChain(): RepeatChainState {
  return { key: null, count: 0 };
}

/** Deep key-sort so argument objects differing only in property order match. */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key]);
    }
    return sorted;
  }
  return value;
}

/** Canonical string form of a call's arguments. */
export function canonicalizeArgs(input: unknown): string {
  return JSON.stringify(sortJsonValue(input)) ?? "null";
}

/** Chain key: the tool plus its full canonical arguments. */
export function chainKey(toolName: string, input: unknown): string {
  return JSON.stringify([toolName, canonicalizeArgs(input)]);
}

/** Reset on user-authored input (direct prompt or steering). */
export function resetRepeatChain(state: RepeatChainState): void {
  state.key = null;
  state.count = 0;
}

/**
 * Record one executed call and return the reminder to append to its result,
 * if a threshold was crossed. The preview cap bounds only the reminder text —
 * detection always compares full canonical arguments.
 */
export function recordCall(state: RepeatChainState, toolName: string, input: unknown): string | null {
  const key = chainKey(toolName, input);
  if (state.key === key) {
    state.count++;
  } else {
    state.key = key;
    state.count = 1;
  }
  if (!REPEAT_THRESHOLDS.includes(state.count)) return null;

  if (state.count === REPEAT_THRESHOLDS[0]) {
    return (
      "\n\n[repeat-call notice] You are repeating the exact same tool call with identical arguments. " +
      "Carefully analyze the previous result before calling again: if the task is not complete, " +
      "try a different approach or different arguments instead of repeating the call."
    );
  }

  const canonical = canonicalizeArgs(input);
  const preview =
    canonical.length > ARGUMENTS_PREVIEW_CHARS
      ? `${canonical.slice(0, ARGUMENTS_PREVIEW_CHARS)}… (${canonical.length - ARGUMENTS_PREVIEW_CHARS} chars omitted)`
      : canonical;
  return (
    `\n\n[repeat-call notice] This is call ${state.count} of "${toolName}" in a row with identical arguments: ${preview}\n` +
    "The repeated calls are not making progress. Do not call this tool with these exact arguments again. " +
    "Inspect the latest result and choose a different action, different arguments, or finish the task if " +
    "enough evidence has been gathered."
  );
}
