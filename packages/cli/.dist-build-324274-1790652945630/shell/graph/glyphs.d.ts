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
export declare function iconMode(env?: NodeJS.ProcessEnv): "unicode" | "nerd";
export declare function graphGlyphs(env?: NodeJS.ProcessEnv): GlyphSet;
