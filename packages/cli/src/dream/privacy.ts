import { redactSecretsForLog, scanForSecrets } from "../content/secrets.js";

/** Redact strings individually so safe surrounding structure survives. Scan the serialized
 * whole too: credential patterns can cross field boundaries or JSON escapes. */
export function sanitizeDream<T>(value: T): T {
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") return redactSecretsForLog(v);
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactSecretsForLog(k), visit(x)]));
    return v;
  };
  const safe = visit(value) as T;
  if (scanForSecrets(JSON.stringify(safe))) throw new Error("Dream data withheld: secret detected after redaction.");
  return safe;
}
