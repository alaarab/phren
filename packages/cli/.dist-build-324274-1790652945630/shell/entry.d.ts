/**
 * Shell entry point: wires PhrenShell to stdin/stdout.
 * Extracted from shell.ts to keep the orchestrator under 300 lines.
 */
import type { ShellStartup } from "./startup.js";
interface LiveStateHost {
    invalidateSubsectionsCache(): void;
    setMessage(message: string): void;
}
interface StartupIntroPlan {
    mode: "always" | "once-per-version" | "off";
    variant: "full" | "final-frame" | "skip";
    holdForKeypress: boolean;
    dwellMs: number;
    markSeen: boolean;
}
/**
 * The intro used to attach its own stdin listener while the shell's key handler
 * was already live, so the keypress that dismissed the splash was *also* fed to
 * the shell (pressing "q" at the splash quit phren outright) and the intro's
 * animation frames raced the first dashboard repaint. Key delivery is now owned
 * by startShell, which hands the intro a one-shot waiter that consumes the key.
 */
export type { KeypressWaiter } from "./intro.js";
export declare function resolveStartupIntroPlan(phrenPath: string, version?: string): StartupIntroPlan;
export declare function startLiveStatePoller({ phrenPath, shell, repaint, isExiting, intervalMs, computeToken, }: {
    phrenPath: string;
    shell: LiveStateHost;
    repaint: () => Promise<void>;
    isExiting?: () => boolean;
    intervalMs?: number;
    computeToken?: (phrenPath: string) => string;
}): () => void;
export declare function startShell(phrenPath: string, profile: string, startup?: ShellStartup): Promise<void>;
