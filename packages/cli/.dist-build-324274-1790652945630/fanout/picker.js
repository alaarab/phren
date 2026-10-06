import { z } from "zod";
export const candidateSchema = z.object({ provider: z.enum(["codex", "opencode", "claude"]), model: z.string().min(1).max(200) });
export const policySchema = z.object({
    threshold: z.number().min(1).max(100).default(80),
    computerCap: z.number().int().positive().default(6),
    providerCap: z.record(z.string(), z.number().int().positive()).default({ codex: 3, claude: 2, "opencode-go": 4 }),
    swiftBuildCap: z.number().int().min(1).max(2).default(2),
    tiers: z.object({ narrow: z.array(candidateSchema).min(1), wide: z.array(candidateSchema).min(1), review: z.array(candidateSchema).min(1) }),
});
export const defaultPolicy = policySchema.parse({ tiers: {
        narrow: [{ provider: "opencode", model: "opencode-go/mimo-v2-flash" }, { provider: "codex", model: "gpt-5.6-terra" }],
        wide: [{ provider: "codex", model: "gpt-6-astra" }, { provider: "claude", model: "opus" }],
        review: [{ provider: "codex", model: "gpt-5.6-terra" }, { provider: "claude", model: "sonnet" }],
    } });
export function providerKey(candidate) {
    return candidate.provider === "opencode" ? candidate.model?.split("/")[0] ?? "opencode" : candidate.provider;
}
export function pick(options) {
    const { policy, running } = options, now = options.now ?? Date.now();
    if (running.length >= policy.computerCap)
        throw new Error("Computer concurrency cap reached.");
    if (options.needsSwift && options.swiftBuilds >= policy.swiftBuildCap)
        throw new Error("Swift build cap reached (2).");
    const override = options.override;
    const candidates = override?.provider && override.model ? [candidateSchema.parse(override)]
        : policy.tiers[options.tier].filter(c => (!override?.provider || c.provider === override.provider) && (!override?.model || c.model === override.model));
    const rejected = [];
    for (const candidate of candidates) {
        const key = providerKey(candidate);
        const error = options.errors.find(e => e.provider === key && e.at <= now && now - e.at < 30 * 60_000);
        if (error) {
            rejected.push(`${key}: ${error.message}`);
            continue;
        }
        if (running.filter(c => providerKey(c) === key).length >= (policy.providerCap[key] ?? 2)) {
            rejected.push(`${key} concurrency cap`);
            continue;
        }
        const account = options.usage.find(a => a.source === key);
        const model = candidate.model.split("/").slice(1).join("/");
        const windowPrefix = `opencode-go:${model.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}:`;
        // Go's plan windows (`opencode-go:plan:*`) bind every Go model.
        const windows = account?.windows.filter(w => key !== "opencode-go" || !model || w.id.startsWith("opencode-go:plan:") || w.id.startsWith(windowPrefix) || w.id.startsWith(`${model}/`) || w.id === model) ?? [];
        const exhausted = windows.find(w => (w.limited || (w.usedPercent ?? 0) >= policy.threshold) && (!w.resetsAt || !Number.isFinite(Date.parse(w.resetsAt)) || Date.parse(w.resetsAt) > now));
        if (exhausted) {
            rejected.push(`${key} ${exhausted.name} at ${exhausted.usedPercent} percent`);
            continue;
        }
        return { ...candidate, reason: `chose ${candidate.provider}/${candidate.model}: ${rejected.join("; ") || (windows.length ? "usage below threshold" : "usage unavailable; first eligible policy candidate")}` };
    }
    throw new Error(`No eligible fan-out provider: ${rejected.join("; ") || "no matching policy candidate"}`);
}
