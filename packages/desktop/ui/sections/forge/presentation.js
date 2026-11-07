// Host vocabulary becomes one display contract, shared by runs, jobs and steps.
export function statusOf(raw, conclusion) {
  const value = String(conclusion || raw || "").toLowerCase();
  if (["success", "passing"].includes(value)) return "success";
  if (["failure", "failed", "error", "timed_out", "action_required", "startup_failure", "failing"].includes(value)) return "failed";
  if (["cancelled", "canceled"].includes(value)) return "canceled";
  if (["skipped", "neutral"].includes(value)) return "skipped";
  if (["in_progress", "running"].includes(value)) return "running";
  if (["blocked", "manual", "waiting", "pending_approval"].includes(value)) return "waiting";
  return "queued";
}
export const terminal = (status) => ["success", "failed", "canceled", "skipped"].includes(statusOf(status));
export function duration(start, end, now = Date.now()) {
  if (!start) return "—";
  const from = Date.parse(start), to = end ? Date.parse(end) : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "—";
  const s = Math.max(0, Math.floor((to - from) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
}
export function webUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
}

// A streaming ANSI decoder. Only SGR foreground/bold styles are allowed;
// OSC (including hyperlinks), cursor commands and other controls never reach DOM.
const COLORS = ["dim", "danger", "done", "waiting", "path", "accent", "path", "text"];
export function createAnsi() {
  let pending = "", color = "", bold = false;
  return {
    append(chunk) {
      const input = pending + chunk;
      pending = "";
      const spans = [];
      function write(text) {
        if (!text) return;
        const cls = [color && `forge-ansi-${color}`, bold && "forge-ansi-bold"].filter(Boolean).join(" ");
        const last = spans.at(-1);
        if (last?.cls === cls) last.text += text; else spans.push({ text, cls });
      }
      let i = 0;
      while (i < input.length) {
        if (input[i] !== "\x1b") {
          const next = input.indexOf("\x1b", i);
          const end = next < 0 ? input.length : next;
          write(input.slice(i, end).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")); i = end; continue;
        }
        const tail = input.slice(i);
        if (tail.length === 1) { pending = tail; break; }
        if (tail[1] === "[") {
          const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(tail);
          if (!match) { if (tail.length <= 128) pending = tail; break; }
          if (match[3] === "m") {
            const codes = (match[1] || "0").split(";").map(Number);
            for (let k = 0; k < codes.length; k++) {
              const code = codes[k];
              if (code === 0) { color = ""; bold = false; }
              else if (code === 1) bold = true;
              else if (code === 22) bold = false;
              else if (code === 39) color = "";
              else if (code >= 30 && code <= 37) color = COLORS[code - 30];
              else if (code >= 90 && code <= 97) color = COLORS[code - 90];
              // Consume extended colour parameters without interpreting them as SGR.
              else if (code === 38 || code === 48 || code === 58) k += codes[k + 1] === 2 ? 4 : codes[k + 1] === 5 ? 2 : 0;
            }
          }
          i += match[0].length;
        } else if (tail[1] === "]") {
          const end = /\x07|\x1b\\/.exec(tail);
          if (!end) { if (tail.length <= 4096) pending = tail; break; }
          i += end.index + end[0].length;
        } else { i += 2; }
      }
      return spans;
    },
  };
}
export function ansiSpans(text) { return createAnsi().append(text); }
export function matches(text, query) {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(text.matchAll(new RegExp(escaped, "gi")), (match) => [match.index, match.index + match[0].length]);
}
