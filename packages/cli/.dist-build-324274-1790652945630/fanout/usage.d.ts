import { type AccountUsage } from "../bridge/usage.js";
import type { ProviderError } from "./picker.js";
export declare function readUsage(): Promise<AccountUsage[]>;
export declare function parseProviderErrors(text: string, now?: number): ProviderError[];
export declare function recentProviderErrors(now?: number): ProviderError[];
