/**
 * Node glyphs for the terminal graph view.
 *
 * The default set is plain Unicode that every monospace font carries. With
 * `PHREN_ICONS=nerd` the view switches to Nerd Font icons (the Font Awesome
 * block, U+F000–U+F2E0, which has been stable across Nerd Font releases), for
 * terminals running a patched font such as JetBrainsMono Nerd Font.
 */

import type { NodeKind } from "../../graph-core/types.js";

export type GlyphSet = Record<NodeKind, string>;

const UNICODE: GlyphSet = {
  project: "◉",
  finding: "✦",
  task: "▤",
  entity: "❖",
  reference: "▣",
  other: "·",
};

const NERD: GlyphSet = {
  project: "", // nf-fa-folder
  finding: "", // nf-fa-lightbulb_o
  task: "", // nf-fa-check_square_o
  entity: "", // nf-fa-share_alt (node graph)
  reference: "", // nf-fa-book
  other: "", // nf-fa-circle
};

export function iconMode(env: NodeJS.ProcessEnv = process.env): "unicode" | "nerd" {
  const raw = (env.PHREN_ICONS || "").trim().toLowerCase();
  return raw === "nerd" || raw === "nerdfont" || raw === "nf" ? "nerd" : "unicode";
}

export function graphGlyphs(env: NodeJS.ProcessEnv = process.env): GlyphSet {
  return iconMode(env) === "nerd" ? NERD : UNICODE;
}
