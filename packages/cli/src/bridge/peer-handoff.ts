/** Only human/agent prose is redacted. Opaque protocol fields (tokens, paths,
 * capabilities, identities and grants) must retain their exact values. */
export function redactPeerHandoff(input: string): string {
  const value = String.raw`(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)`;
  let text = input.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/(?<![\w.+-])([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]+@/gi, "$1[redacted]@")
    .replace(/(\b(?:Authorization|Cookie|Set-Cookie|X-API-Key)[\t ]*:[\t ]*)[^\r\n]*/gi, "$1[redacted]")
    .replace(new RegExp(String.raw`(\bBearer[\t ]+)${value}`, "gi"), "$1[redacted]")
    .replace(/\b(?:mysql|curl)\b[^\r\n]*/gi, line => {
      if (/\bmysql\b/i.test(line)) line = line.replace(/([\t ]-p)(?![\t ]|$)[^\s]+/g, "$1[redacted]");
      if (/\bcurl\b/i.test(line)) line = line.replace(new RegExp(String.raw`([\t ](?:-u|--user)[\t ]+)${value}`, "g"), "$1[redacted]");
      return line;
    });
  // Consume each identifier once, then inspect its name. Requiring a genuine
  // token boundary prevents restarting a greedy search at each dot in a path.
  const keys = /(?<![\w.-])(?:"([\w.-]+)"|'([\w.-]+)'|([\w.-]+))([\t ]*(?:[:=][\t ]*|[\t ]+))/g;
  const secretName = /pass|pwd|token|secret|api[-_]?key|auth|bearer|credential/i;
  const values = new RegExp(value, "y");
  const parts: string[] = [];
  let copied = 0;
  for (let match; (match = keys.exec(text));) {
    const name = match[1] ?? match[2] ?? match[3];
    const cleanName = name.replace(/^--/, "");
    if (!secretName.test(cleanName) || /^(?:author|authority)$/i.test(cleanName) || !name.startsWith("--") && !/[:=]/.test(match[4]) && cleanName.toLowerCase() !== "bearer") continue;
    const start = keys.lastIndex;
    values.lastIndex = start;
    let found = values.exec(text);
    if (found?.[0] === "-p") {
      values.lastIndex = start + 2 + (/^[\t ]*/.exec(text.slice(start + 2))?.[0].length ?? 0);
      found = values.exec(text);
    }
    if (!found && text[start] !== "\n" && text[start] !== "\r" && start !== text.length) continue;
    const end = found ? values.lastIndex : start;
    parts.push(text.slice(copied, start), "[redacted]");
    copied = end;
    keys.lastIndex = end;
  }
  parts.push(text.slice(copied));
  text = parts.join("");
  // Recognizable credential formats are excised, never inferred from the
  // length/base64 shape of ordinary paths or used to refuse a continuation.
  return text.replace(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)|\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|AIza[0-9A-Za-z_-]{35}|sk-ant-api\d{2}-[\w-]{10,}|sk-proj-[\w-]{30,}|[sp]k_live_[A-Za-z0-9]{24,}|npm_[A-Za-z0-9]{36}|xox[bp]-[0-9]+-[A-Za-z0-9-]+)|(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]+|https:\/\/hooks\.slack\.com\/services\/T\w+\/B\w+\/\w+/g, "[redacted]");
}

const proseFields = new Set(["text", "prompt", "reply", "error", "message", "notice", "reason", "description", "title", "label", "question", "request"]);
/** Conductor operation envelopes contain prose beside opaque routing data. */
export function redactPeerPayload<T>(data: T): T {
  return JSON.parse(JSON.stringify(data, (key, value) => typeof value === "string" && proseFields.has(key) ? redactPeerHandoff(value) : value));
}
