export declare class LoopWatchdog {
    private calls;
    observe(event: Record<string, unknown>): void;
    reason(): string | undefined;
}
export declare function stderrRefusal(tail: string): {
    type: string;
    pattern: string;
    message: string;
} | undefined;
