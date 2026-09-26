import * as dns from "node:dns/promises";
import * as net from "node:net";
import type { AgentTool } from "./types.js";

/**
 * SSRF guard: block URLs that resolve to private, loopback, or link-local
 * addresses so an injected "fetch this URL" can't reach cloud metadata
 * endpoints or internal services. PHREN_AGENT_ALLOW_PRIVATE_FETCH=1 disables
 * (for users whose docs genuinely live on their LAN).
 */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    // Normalize the unambiguous cases: loopback, link-local, unique-local, v4-mapped
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    const v4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) return isPrivateAddress(v4[1]);
    return false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // unparseable — fail closed
  }
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;          // private, loopback, "this"
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
  if (a === 192 && b === 168) return true;                    // 192.168/16
  if (a === 169 && b === 254) return true;                    // link-local (cloud metadata!)
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64/10
  return false;
}

/** Returns a rejection reason, or null when the URL is safe to fetch. */
export async function checkUrlSafety(rawUrl: string): Promise<string | null> {
  if (process.env.PHREN_AGENT_ALLOW_PRIVATE_FETCH === "1") return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `Invalid URL: ${rawUrl}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Only http/https URLs are allowed (got ${parsed.protocol})`;
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    return isPrivateAddress(host)
      ? `Blocked: ${host} is a private/loopback/link-local address (SSRF guard; PHREN_AGENT_ALLOW_PRIVATE_FETCH=1 to override)`
      : null;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return `Blocked: ${host} is a local hostname (SSRF guard; PHREN_AGENT_ALLOW_PRIVATE_FETCH=1 to override)`;
  }

  try {
    const results = await dns.lookup(host, { all: true });
    for (const { address } of results) {
      if (isPrivateAddress(address)) {
        return `Blocked: ${host} resolves to private address ${address} (SSRF guard; PHREN_AGENT_ALLOW_PRIVATE_FETCH=1 to override)`;
      }
    }
  } catch {
    return `Could not resolve host: ${host}`;
  }
  return null;
}

export function createWebFetchTool(): AgentTool {
  return {
    name: "web_fetch",
    description: "Fetch a URL and return its text content. Use for reading documentation, API references, or web pages. Returns plain text (HTML tags stripped). Max 50KB response.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch." },
        max_length: { type: "number", description: "Max response length in characters. Default: 50000." },
      },
      required: ["url"],
    },
    async execute(input, signal) {
      const url = input.url as string;
      const maxLen = (input.max_length as number) || 50_000;

      const unsafe = await checkUrlSafety(url);
      if (unsafe) return { output: unsafe, is_error: true };

      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "phren-agent/0.1" },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
          redirect: "manual",
        });

        // Follow redirects manually so each hop goes through the SSRF guard.
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) return { output: `HTTP ${res.status} with no Location header`, is_error: true };
          const next = new URL(location, url).toString();
          const nextUnsafe = await checkUrlSafety(next);
          if (nextUnsafe) return { output: `Redirect to unsafe target: ${nextUnsafe}`, is_error: true };
          const res2 = await fetch(next, {
            headers: { "User-Agent": "phren-agent/0.1" },
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
          });
          if (!res2.ok) return { output: `HTTP ${res2.status}: ${res2.statusText}`, is_error: true };
          return { output: cleanHtml(await res2.text(), maxLen) };
        }

        if (!res.ok) return { output: `HTTP ${res.status}: ${res.statusText}`, is_error: true };
        return { output: cleanHtml(await res.text(), maxLen) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Fetch failed: ${msg}`, is_error: true };
      }
    },
  };
}

function cleanHtml(raw: string, maxLen: number): string {
  let text = raw;
  // Strip HTML tags for readability
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\s{2,}/g, " ").trim();
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + `\n\n[truncated at ${maxLen} chars]`;
  }
  return text;
}
