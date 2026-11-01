/** Harness-native prompt identities, normalized once for both the lifecycle
 * callback and the transcript reader. Claude is the only harness with a
 * prompt-specific identity today; other harnesses leave the field absent. */

/** A bounded, opaque Claude prompt id. Absent, malformed or oversized ids stay
 * unavailable rather than being inferred from text, time or transcript order. */
export function claudePromptEntryId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,192}$/.test(value)) return undefined;
  const id = `claude:prompt:${value}`;
  return id.length <= 256 ? id : undefined;
}

/** Validate an already-normalized wire value (the Hook's callback body). */
export function normalizedPromptEntryId(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 256 && /^claude:prompt:[A-Za-z0-9._:-]{1,192}$/.test(value) ? value : undefined;
}
