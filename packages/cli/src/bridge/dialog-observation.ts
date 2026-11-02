import { intervalFromEnv } from "./limits.js";

/** Discovery is frequent by default; an owner can still cap polling explicitly.
 * Confirmation has its own small, fixed budget, independent of that cap. */
export const DIALOG_READ_MS = intervalFromEnv("PHREN_DIALOG_THROTTLE_MS", 350);
export const DIALOG_CONFIRM_MS = 300;
const CONFIRM_READ_MS = 400;

export async function confirmDialogRead<T>(read: () => Promise<T>, current: () => boolean): Promise<T | undefined> {
  await new Promise<void>(resolve => setTimeout(resolve, DIALOG_CONFIRM_MS));
  if (!current()) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read().catch(() => undefined), new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), CONFIRM_READ_MS);
    })]);
  } finally { clearTimeout(timer); }
}
