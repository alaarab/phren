/** Remove structural credentials from the whole normalized outbound hand-off,
 * including conversation fallback text. The caller still scans the result for
 * credential formats that do not have a recognizable key or header. */
export function redactPeerHandoff(prompt: string): string {
  const names = String.raw`(?:[a-z][\w.-]*[_-])?(?:password|passwd|pwd|token|secret|api[-_]?key|auth|bearer|authorization)`;
  const value = String.raw`(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)`;
  return prompt
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]+@/gi, "$1[redacted]@")
    .replace(/(\bAuthorization[\t ]*:[\t ]*)[^\r\n]*/gi, "$1[redacted]")
    .replace(new RegExp(String.raw`(\bBearer[\t ]+)${value}`, "gi"), "$1[redacted]")
    .replace(new RegExp(String.raw`((?<![\w-])--${names}[\t ]+-p[\t ]+)${value}`, "gi"), "$1[redacted]")
    .replace(new RegExp(String.raw`((?<![\w-])--${names}(?:[\t ]*=[\t ]*|[\t ]+))${value}`, "gi"), "$1[redacted]")
    .replace(new RegExp(String.raw`((?<![\w-])["']?${names}["']?[\t ]*[:=][\t ]*)${value}`, "gi"), "$1[redacted]");
}
