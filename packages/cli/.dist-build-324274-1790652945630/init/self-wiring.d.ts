import { type ManagementPreset } from "./management-preset.js";
/** Build the self-wiring instructions as lines (testable without stdout). */
export declare function buildSelfWiringSnippet(phrenPath: string, preset: ManagementPreset): string[];
/** Print the self-wiring snippet for the given (or current) preset. */
export declare function printSelfWiringSnippet(phrenPath: string, preset?: ManagementPreset): void;
