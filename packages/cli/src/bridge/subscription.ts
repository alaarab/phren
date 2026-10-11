/** Public subscription metadata only. Credentials never enter this contract. */
export interface Subscription {
  plan: string;
  startedAt?: string;
  renewsAt?: string;
  renewsEstimated?: boolean;
  checkedAt?: string;
}

/** Provider identifiers, not arbitrary free text or credentials. */
export function planName(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[a-z0-9_+ -]{1,64}$/i.test(value) || !value.trim()) return undefined;
  return value.trim().replace(/^default_claude_/, "").replace(/^claude_/, "").split(/[_ -]+/)
    .map(word => /^\d+x$/i.test(word) ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

const CLAUDE_PLANS: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };

/**
 * A Claude login's plan from its oauthAccount profile, as Claude names it:
 * the organization type first (a Team or Enterprise seat can carry any rate
 * tier), the rate tier only for Pro and Max's 5x or 20x, then the billing
 * type and Claude Code's own `subscriptionType`. Internal tier codes
 * ("default_raven") are never shown; an unknown plan is undefined.
 */
export function claudePlan(profile: { organizationType?: unknown; seatTier?: unknown; organizationRateLimitTier?: unknown; userRateLimitTier?: unknown; billingType?: unknown; subscriptionType?: unknown }): string | undefined {
  const text = (value: unknown) => typeof value === "string" && value.length <= 64 ? value.toLowerCase() : "";
  const kind = (value: string) => /^(?:claude_)?(pro|max|team|enterprise)(?:_subscription)?$/.exec(value)?.[1];
  const tier = [text(profile.organizationRateLimitTier), text(profile.userRateLimitTier)];
  const multiple = tier.map(value => /^default_claude_max_(5|20)x$/.exec(value)?.[1]).find(Boolean);
  const fromTier = tier.map(value => value === "default_claude_ai" || value === "default_claude_pro" ? "pro" : /^default_claude_max(?:_\d+x)?$/.test(value) ? "max" : undefined).find(Boolean);
  const plan = kind(text(profile.organizationType)) ?? fromTier ?? kind(text(profile.billingType)) ?? kind(text(profile.subscriptionType));
  if (!plan) return undefined;
  if (plan === "max" && multiple) return `Max ${multiple}x`;
  if (plan === "team" && text(profile.seatTier) === "team_premium") return "Team Premium";
  return CLAUDE_PLANS[plan];
}

export function subscriptionDate(value: unknown): string | undefined {
  const time = typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) ? Date.parse(value)
    : typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 32_503_680_000 ? value * 1000 : NaN;
  return Number.isFinite(time) && time > 0 && time < 32_503_680_000_000 ? new Date(time).toISOString() : undefined;
}

/** Next anniversary in UTC, always using the original day (Jan 31 -> Feb 28 -> Mar 31). */
export function monthlyAnniversary(startedAt: string, now: Date): string | undefined {
  const start = new Date(startedAt);
  if (!Number.isFinite(start.getTime()) || start > now) return undefined;
  const candidate = (month: number) => {
    const lastDay = new Date(Date.UTC(now.getUTCFullYear(), month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(now.getUTCFullYear(), month, Math.min(start.getUTCDate(), lastDay),
      start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()));
  };
  const next = candidate(now.getUTCMonth());
  return (next > now ? next : candidate(now.getUTCMonth() + 1)).toISOString();
}
