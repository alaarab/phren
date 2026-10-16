import { redactSecretsForLog, scanForSecrets } from "../content/secrets.js";
import { BridgeError } from "./protocol.js";
/** Remove structural credentials from the whole normalized outbound hand-off,
 * including conversation fallback text. The caller still scans the result for
 * credential formats that do not have a recognizable key or header. */
export function redactPeerHandoff(prompt: string): string {
  const names = String.raw`[\w.-]*(?:pass(?:word|wd|phrase)?|pwd|token|secret|api[-_]?key|auth|bearer|credential)[\w.-]*`;
  const value = String.raw`(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)`;
  return prompt
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]+@/gi, "$1[redacted]@")
    .replace(/(\b(?:Authorization|Cookie|Set-Cookie|X-API-Key)[\t ]*:[\t ]*)[^\r\n]*/gi, "$1[redacted]")
    .replace(/(\bmysql\b[^\r\n]*?[\t ]-p)(?![\t \r\n]|$)[^\s]+/gi, "$1[redacted]")
    .replace(new RegExp(String.raw`(\bcurl\b[^\r\n]*?[\t ](?:-u|--user)[\t ]+)${value}`, "gi"), "$1[redacted]")
    .replace(new RegExp(String.raw`(\bBearer[\t ]+)${value}`, "gi"), "$1[redacted]")
    .replace(new RegExp(String.raw`((?<![\w-])--${names}[\t ]+-p[\t ]+)${value}`, "gi"), "$1[redacted]")
    .replace(new RegExp(String.raw`((?<![\w-])--${names}(?:[\t ]*=[\t ]*|[\t ]+))${value}`, "gi"), "$1[redacted]")
    .replace(new RegExp(String.raw`((?<![\w-])["']?${names}["']?[\t ]*[:=][\t ]*)${value}`, "gi"), "$1[redacted]")
    .replace(new RegExp(String.raw`((?<![\w-])["']?${names}["']?[\t ]*[:=][\t ]*)(?=\r?\n|$)`, "gi"), "$1[redacted]");
}

/** The final transport boundary applies the same policy to every string and
 * credential-shaped object key, including notices and operation replies. */
export function redactPeerPayload<T>(data: T, response = false): T {
  return JSON.parse(JSON.stringify(data, (key, value) => {
    if (/(?:pass(?:word|wd|phrase)?|pwd|token|secret|api[-_]?key|auth|bearer|credential)/i.test(key)) return "[redacted]";
    if (typeof value !== "string") return value;
    let normalized = redactPeerHandoff(value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""));
    if (response) normalized = redactSecretsForLog(normalized);
    if (scanForSecrets(normalized)) {
      if (response) return "[redacted]";
      throw new BridgeError(409, "The hand-off contains a credential");
    }
    return normalized;
  }));
}
