import { createCaptureState } from "../memory/auto-capture.js";
import { AntiPatternTracker } from "../memory/anti-patterns.js";
import { createFlushConfig } from "../memory/context-flush.js";
export function createSession(contextLimit) {
    return {
        messages: [],
        turns: 0,
        toolCalls: 0,
        captureState: createCaptureState(),
        antiPatterns: new AntiPatternTracker(),
        flushConfig: createFlushConfig(contextLimit ?? 200_000),
    };
}
