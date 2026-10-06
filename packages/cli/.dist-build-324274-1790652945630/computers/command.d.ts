import { type HarnessUsage } from "./read.js";
import type { ComputerResources } from "../bridge/resources.js";
export declare function formatResources(name: string, r: ComputerResources, detail: boolean): string[];
export declare function formatHarness(h: HarnessUsage): string[];
export declare function runComputers(args: string[]): Promise<number>;
export declare function runUsage(args: string[]): Promise<number>;
