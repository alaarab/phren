/**
 * --context-window and --price-* describe the model they were given with.
 * They used to be copied into PHREN_AGENT_* env vars, which then applied to
 * whatever model /model switched to. Kept here instead, keyed by the model
 * id the provider resolved, and handed to subagents in their spawn payload
 * so a child on the same model gets them and a child on another does not.
 */
export interface ModelOverrides {
  contextWindow?: number;
  /** USD per 1M tokens. */
  priceIn?: number;
  priceOut?: number;
  priceCache?: number;
}

export interface ScopedModelOverrides extends ModelOverrides {
  model: string;
}

let scoped: ScopedModelOverrides | undefined;

/** Pin the overrides to `model`, or clear them when none are set. */
export function scopeModelOverrides(model: string | undefined, overrides: ModelOverrides): void {
  const set = Object.values(overrides).some((v) => v !== undefined);
  scoped = model && set ? { model, ...overrides } : undefined;
}

/** The overrides that apply to `model`; none for any other model. */
export function overridesFor(model: string | undefined): ModelOverrides {
  if (!scoped || model !== scoped.model) return {};
  const { model: _model, ...overrides } = scoped;
  return overrides;
}

/** The current scope, for a subagent's spawn payload. */
export function scopedModelOverrides(): ScopedModelOverrides | undefined {
  return scoped ? { ...scoped } : undefined;
}
