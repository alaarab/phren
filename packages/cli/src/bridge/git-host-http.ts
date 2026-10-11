import type { Json } from "./protocol.js";
import { git } from "./projects.js";

/** A small JSON client for the git hosts the Hook reads over HTTP. Every call
 * has a deadline, never follows a redirect to another origin with the token,
 * and turns a host's refusal into one of a few reasons clients can act on. */

export type HostFailure = "auth" | "not-found" | "unreachable" | "failed";

export class HostApiError extends Error {
  constructor(public reason: HostFailure, message: string, public status = 0) { super(message); }
}

/** The API root for a domain: `git config phren.<domain>.api` when set (a
 * self-hosted server on another port or path), else the host's default. */
export async function apiRoot(root: string, domain: string, fallback: string): Promise<string> {
  const configured = (await git(root, "config", "--get", `phren.${domain}.api`).catch(() => "")).trim();
  return (configured || fallback).replace(/\/+$/, "");
}

export interface HostRequest {
  token?: string;
  /** How the token is sent: GitLab's PRIVATE-TOKEN header or a bearer token. */
  scheme: "private-token" | "bearer";
  method?: "GET" | "POST" | "PUT";
  body?: Json;
  timeoutMs?: number;
}

export async function hostJson<T = unknown>(url: string, request: HostRequest): Promise<{ status: number; json: T; headers: Headers }> {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "phren-hook" };
  if (request.token) {
    if (request.scheme === "private-token") headers["PRIVATE-TOKEN"] = request.token;
    else headers.authorization = `Bearer ${request.token}`;
  }
  if (request.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method ?? "GET", headers, redirect: "manual",
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(request.timeoutMs ?? 15_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new HostApiError("unreachable", timedOut ? `${new URL(url).host} did not answer within ${Math.round((request.timeoutMs ?? 15_000) / 1000)} seconds.` : `Could not reach ${new URL(url).host}.`);
  }
  if (response.status >= 300 && response.status < 400) throw new HostApiError("failed", `${new URL(url).host} redirected the API call; set its API address with git config phren.<domain>.api <url>.`, response.status);
  const text = await response.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (response.status === 401) throw new HostApiError("auth", "The host refused the token: it is missing, expired or revoked.", 401);
  if (response.status === 403) throw new HostApiError("auth", "The token cannot read this repository; it needs read access to its code, requests and pipelines.", 403);
  if (response.status === 404) throw new HostApiError("not-found", "The host has no such repository, or the token cannot see it.", 404);
  if (response.status >= 400) {
    const message = json && typeof json === "object" ? (json as Json).message ?? (json as Json).error : undefined;
    throw new HostApiError("failed", `${new URL(url).host} answered ${response.status}${message ? `: ${typeof message === "string" ? message : JSON.stringify(message)}` : ""}`.slice(0, 500), response.status);
  }
  return { status: response.status, json: json as T, headers: response.headers };
}

/** An https link, or nothing: hosts' links are shown and opened as-is. */
export function safeLink(value: unknown): string | undefined {
  return typeof value === "string" && /^https?:\/\//.test(value) ? value.slice(0, 2048) : undefined;
}
