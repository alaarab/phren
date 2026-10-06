export declare function buildProactivitySnapshot(phrenPath: string): {
    path: string;
    configured: {
        proactivity: "high" | "low" | "medium" | null;
        proactivityFindings: "high" | "low" | "medium" | null;
        proactivityTask: "high" | "low" | "medium" | null;
    };
    effective: {
        proactivity: "high" | "low" | "medium";
        proactivityFindings: "high" | "low" | "medium";
        proactivityTask: "high" | "low" | "medium";
    };
};
type ProactivitySubcommand = "proactivity" | "proactivity.findings" | "proactivity.tasks";
export declare function handleConfigProactivity(requested: ProactivitySubcommand, args: string[]): void;
export declare function handleConfigProjectOwnership(args: string[]): void;
export {};
