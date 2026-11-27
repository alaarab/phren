/**
 * Temporary stand-ins for the admission and audit exports worker B is adding to
 * `mac-windows.ts` (`bridge/mac-window-stream.ts` imports them from here until
 * the lead switches the import to `./mac-windows.js` and deletes this file).
 *
 * The shapes are the contract's; the stub admits every stream and logs nothing,
 * so the stream loop can be built and tested before B lands. Never ship it.
 */

/** Why a lease ended without the phone closing it. */
export type MacWindowStreamEnd = "mac-windows-disabled" | "mac-windows-stopped" | "mac-windows-badge";

/** One admitted stream: the session and badge it pins, released by `finish`. */
export interface MacWindowStreamLease { finish(reason?: string): Promise<void> }

export async function beginMacWindowStream(
  _owner: boolean,
  _id: number,
  _onEnd: (reason: MacWindowStreamEnd) => void,
): Promise<MacWindowStreamLease> {
  return { async finish() {} };
}

export async function logMacWindowStreamRefusal(_reason: string, _id?: number): Promise<void> {}
