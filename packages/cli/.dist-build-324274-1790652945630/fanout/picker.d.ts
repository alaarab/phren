import { z } from "zod";
import type { AccountUsage } from "../bridge/usage.js";
import type { Provider } from "./adapters/types.js";
export declare const candidateSchema: z.ZodObject<{
    provider: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        opencode: "opencode";
    }>;
    model: z.ZodString;
}, z.core.$strip>;
export declare const policySchema: z.ZodObject<{
    threshold: z.ZodDefault<z.ZodNumber>;
    computerCap: z.ZodDefault<z.ZodNumber>;
    providerCap: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    swiftBuildCap: z.ZodDefault<z.ZodNumber>;
    tiers: z.ZodObject<{
        narrow: z.ZodArray<z.ZodObject<{
            provider: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                opencode: "opencode";
            }>;
            model: z.ZodString;
        }, z.core.$strip>>;
        wide: z.ZodArray<z.ZodObject<{
            provider: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                opencode: "opencode";
            }>;
            model: z.ZodString;
        }, z.core.$strip>>;
        review: z.ZodArray<z.ZodObject<{
            provider: z.ZodEnum<{
                claude: "claude";
                codex: "codex";
                opencode: "opencode";
            }>;
            model: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type Candidate = z.infer<typeof candidateSchema>;
export type Policy = z.infer<typeof policySchema>;
export type Tier = "narrow" | "wide" | "review";
export interface ProviderError {
    provider: string;
    at: number;
    message: string;
}
export declare const defaultPolicy: {
    threshold: number;
    computerCap: number;
    providerCap: Record<string, number>;
    swiftBuildCap: number;
    tiers: {
        narrow: {
            provider: "claude" | "codex" | "opencode";
            model: string;
        }[];
        wide: {
            provider: "claude" | "codex" | "opencode";
            model: string;
        }[];
        review: {
            provider: "claude" | "codex" | "opencode";
            model: string;
        }[];
    };
};
export declare function providerKey(candidate: {
    provider: Provider;
    model?: string;
}): string;
export declare function pick(options: {
    policy: Policy;
    tier: Tier;
    usage: AccountUsage[];
    errors: ProviderError[];
    running: {
        provider: Provider;
        model?: string;
    }[];
    swiftBuilds: number;
    needsSwift: boolean;
    now?: number;
    override?: Partial<Candidate>;
}): Candidate & {
    reason: string;
};
