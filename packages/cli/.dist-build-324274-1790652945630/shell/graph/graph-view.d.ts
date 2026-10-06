/**
 * Renders the terminal graph view: a braille force-graph canvas with a
 * details pane beside it (or a strip beneath it on narrow terminals).
 *
 * Mirrors the web viewer's layout — canvas left, contents pane right — and
 * its colour language: nodes take their topic/kind colour, the selection is
 * amber, search dims everything that does not match.
 */
import type { GraphController } from "./controller.js";
/**
 * The pane takes a share of a wide terminal rather than a fixed 34 columns:
 * a finding wraps into far fewer lines at 50 cells than at 32, which is the
 * difference between reading it and reading the first third of it.
 */
export declare function paneWidthFor(width: number): number;
/** Word-wrap plain text to `width` cells, at most `maxLines` lines, ellipsised. */
export declare function wrapText(text: string, width: number, maxLines: number): string[];
export declare function renderGraphView(controller: GraphController, width: number, height: number): string[];
/**
 * The one line of graph state worth spending characters on, rendered into the
 * shell header rather than a row of its own. A legend of kind counts told you
 * nothing the colours on screen did not, but whether you are looking at your
 * whole store or a sample of it changes how you read the picture.
 */
export declare function graphSummary(controller: GraphController): string;
