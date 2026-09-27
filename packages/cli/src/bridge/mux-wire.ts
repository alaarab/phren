import type { Json } from "./protocol.js";

/** Installed phones require the historical Herdr envelope even for tmux.
 * A typed tmux selector opts into the source kind; the additive descriptor
 * remains accurate in both formats. */
export function typedMuxRequest(url: URL): boolean {
  return url.searchParams.get("mux")?.startsWith("tmux:") === true;
}

export function muxReplyForClient(reply: Json, typed: boolean): Json {
  return !typed && reply.kind === "tmux" ? { ...reply, kind: "herdr" } : reply;
}

/** New clients request /v1/muxes?typed=1. Older Hooks ignore that query,
 * so callers must also accept the legacy Herdr aliases. */
export function muxListForClient(muxes: Json[], typed: boolean): Json[] {
  return muxes.map(mux => {
    if (typed || mux.kind !== "tmux") return mux;
    return { ...mux, id: `herdr:${mux.session}`, kind: "herdr",
      mux: { id: mux.id, kind: mux.kind, session: mux.session } };
  });
}
