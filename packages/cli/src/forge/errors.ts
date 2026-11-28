export class ForgeError extends Error {
  constructor(public code: "auth" | "not-found" | "forbidden" | "rate-limited" | "unavailable" | "invalid", message: string) {
    super(message);
    this.name = "ForgeError";
  }
}

const MESSAGES: Record<ForgeError["code"], string> = {
  auth: "Sign in to the forge or renew its credentials.",
  "not-found": "The forge repository or issue was not found.",
  forbidden: "The forge denied access to this operation.",
  "rate-limited": "The forge rate limit was reached. Try again later.",
  unavailable: "The forge did not complete the request.",
  invalid: "The forge rejected the request.",
};

/** The response and subprocess diagnostics may contain credentials or issue content. */
export function forgeFailure(status: number, rateLimited = false): ForgeError {
  let code: ForgeError["code"] = "unavailable";
  if (status === 429 || rateLimited) code = "rate-limited";
  else if (status === 401) code = "auth";
  else if (status === 403) code = "forbidden";
  else if (status === 404 || status === 410) code = "not-found";
  else if (status >= 400 && status < 500) code = "invalid";
  return new ForgeError(code, MESSAGES[code]);
}
