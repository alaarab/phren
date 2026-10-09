// Unified-diff helpers for the Changes view. Plain browser ES module: no imports,
// so it also runs under Node in patch.test.ts.

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const NO_NEWLINE = "\\ No newline at end of file";

/** Parse unified diff text into hunks with per-line old/new numbers, as git prints it. */
export function parsePatch(patch) {
  const hunks = [];
  let hunk = null;
  const body = patch.endsWith("\n") ? patch.slice(0, -1) : patch;
  for (const rawLine of body.split("\n")) {
    const raw = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (raw.startsWith(NO_NEWLINE)) {
      if (hunk && hunk.lines.length) hunk.lines[hunk.lines.length - 1].noNewline = true;
      continue;
    }
    const m = HUNK.exec(raw);
    if (m) {
      hunk = {
        header: m[5],
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
        seenOld: 0,
        seenNew: 0,
      };
      hunks.push(hunk);
      continue;
    }
    // Only lines while the hunk still needs them are content; file headers fall through.
    if (hunk && (hunk.seenOld < hunk.oldCount || hunk.seenNew < hunk.newCount)) {
      const kind = raw[0] === "+" ? "add" : raw[0] === "-" ? "del" : "context";
      hunk.lines.push({
        kind,
        text: raw.slice(1),
        oldLine: kind === "add" ? null : hunk.oldStart + hunk.seenOld,
        newLine: kind === "del" ? null : hunk.newStart + hunk.seenNew,
        noNewline: false,
      });
      if (kind !== "add") hunk.seenOld++;
      if (kind !== "del") hunk.seenNew++;
    }
  }
  return hunks.map(({ seenOld, seenNew, ...rest }) => rest);
}

/** Split text into lines and remember whether it ended with a line break. */
function splitLines(text) {
  const hasFinal = /\r?\n$/.test(text);
  const body = hasFinal ? text.replace(/\r?\n$/, "") : text;
  const lines = body === "" && !hasFinal ? [] : body.split(/\r?\n/);
  return { lines, hasFinal };
}

/** Rebuild the old file from the new text and the patch that produced it. */
export function reverseApply(newText, patch) {
  const hunks = parsePatch(patch);
  const eol = newText.includes("\r\n") ? "\r\n" : "\n";
  const { lines: newLines, hasFinal } = splitLines(newText);
  const out = [];
  let cursor = 0;
  let lastOldNoNewline = false;
  const mismatch = () => new Error("The patch does not match the file.");
  for (const hunk of hunks) {
    // newStart is 0 for a hunk that only deletes (the new file has no lines there).
    const start = hunk.newStart > 0 ? hunk.newStart - 1 : 0;
    if (start < cursor || start > newLines.length) throw mismatch();
    while (cursor < start) out.push(newLines[cursor++]);
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        if (newLines[cursor] !== line.text) throw mismatch();
        cursor++;
      } else {
        if (line.kind === "context") {
          if (newLines[cursor] !== line.text) throw mismatch();
          cursor++;
        }
        out.push(line.text);
        lastOldNoNewline = line.noNewline;
      }
    }
  }
  const tailCopied = cursor < newLines.length;
  while (cursor < newLines.length) out.push(newLines[cursor++]);
  let result = out.join(eol);
  const finalNewline = tailCopied ? hasFinal : out.length > 0 && !lastOldNoNewline;
  if (out.length > 0 && finalNewline) result += eol;
  return result;
}

const TOKEN = /(\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_])/;

function tokenize(line) {
  return line.split(TOKEN).filter((token) => token !== "");
}

/** Split two lines into tokens, flagging tokens outside their longest common subsequence. */
export function wordSegments(oldLine, newLine) {
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  if (a.length > 400 || b.length > 400) {
    return { old: a.map((text) => ({ text, changed: true })), new: b.map((text) => ({ text, changed: true })) };
  }
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const oldChanged = new Array(n).fill(true);
  const newChanged = new Array(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      oldChanged[i] = false;
      newChanged[j] = false;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return {
    old: a.map((text, k) => ({ text, changed: oldChanged[k] })),
    new: b.map((text, k) => ({ text, changed: newChanged[k] })),
  };
}
