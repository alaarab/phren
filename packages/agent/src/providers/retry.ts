export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatuses: Set<number>;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  retryableStatuses: new Set([429, 500, 502, 503, 529]),
};

const RETRYABLE_NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"]);

/** Extract HTTP status from error message like "API error 429: ..." */
function extractStatus(error: unknown): number | null {
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/\berror\s+(\d{3})\b/i);
  return match ? parseInt(match[1], 10) : null;
}

/** Check if the error is a retryable network error by code or message. */
function isNetworkError(error: unknown): boolean {
  if (error instanceof Error && "code" in error) {
    const code = (error as Error & { code?: string }).code;
    if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return RETRYABLE_NETWORK_CODES.has(msg) || Array.from(RETRYABLE_NETWORK_CODES).some((c) => msg.includes(c));
}

/** Extract Retry-After hint from error message. */
function extractRetryAfter(error: unknown): number | null {
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/retry[- ]?after[:\s]+(\d+)/i);
  return match ? parseInt(match[1], 10) * 1000 : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Aborted")); return; }
    const onAbort = () => { clearTimeout(timer); reject(new Error("Aborted")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The provider rejected the request because the prompt is too long for the
 * model. Retrying unchanged cannot help; compacting the history can. Matches
 * the wording of Anthropic, OpenAI (Chat and Responses), OpenRouter,
 * DeepSeek, Gemini-via-gateway and Ollama errors.
 */
export function isContextOverflowError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /context[_ ]length[_ ]exceeded|maximum context length|context window|prompt is too long|input is too long|too many (input )?tokens|exceeds? the (model's )?(maximum )?context|reduce the length of the messages|request too large|input length and `max_tokens` exceed/i.test(msg)
    || extractStatus(error) === 413;
}

/**
 * A 429 that means "out of quota" (a subscription's weekly limit, an empty
 * API balance) rather than "slow down". It resets in hours or never, so
 * backing off for seconds only delays the error.
 */
export function isQuotaExhausted(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /usage_limit_reached|insufficient_quota|insufficient[_ ]balance|exceeded your current quota|credit balance is too low/i.test(msg);
}

/** Wrap an async function with exponential backoff retry. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>,
  verbose?: boolean,
  signal?: AbortSignal,
): Promise<T> {
  const cfg: RetryConfig = { ...DEFAULT_CONFIG, ...config };

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new Error("Aborted");
    try {
      return await fn();
    } catch (error) {
      if (signal?.aborted) throw error;
      const status = extractStatus(error);
      const isRetryable = !isQuotaExhausted(error)
        && ((status !== null && cfg.retryableStatuses.has(status)) || isNetworkError(error));

      if (!isRetryable || attempt >= cfg.maxRetries) {
        throw error;
      }

      const retryAfterMs = extractRetryAfter(error);
      const backoff = Math.min(
        cfg.baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000,
        cfg.maxDelayMs,
      );
      const delayMs = retryAfterMs ?? backoff;

      if (verbose) {
        process.stderr.write(
          `Retry ${attempt + 1}/${cfg.maxRetries} after ${Math.round(delayMs)}ms (status ${status})\n`,
        );
      }

      await sleep(delayMs, signal);
    }
  }
}
