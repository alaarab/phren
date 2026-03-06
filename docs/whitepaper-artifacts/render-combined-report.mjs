import fs from 'fs';

const inputPath = '/home/alaarab/cortex/docs/long-term-memory-report-combined.md';
const outputPath = '/home/alaarab/cortex/docs/long-term-memory-report-combined.html';

const md = fs.readFileSync(inputPath, 'utf8');

function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

const lines = md.split('\n');
let out = '';
let inCode = false;
let codeLang = '';
let inUl = false;
let inOl = false;
let inTable = false;
let tableRows = [];

function closeLists() {
  if (inUl) { out += '</ul>\n'; inUl = false; }
  if (inOl) { out += '</ol>\n'; inOl = false; }
}

function flushTable() {
  if (!inTable) return;
  if (tableRows.length >= 2) {
    const header = tableRows[0];
    const body = tableRows.slice(2);
    out += '<table><thead><tr>' + header.map(c => `<th>${inline(c.trim())}</th>`).join('') + '</tr></thead><tbody>';
    for (const row of body) {
      out += '<tr>' + row.map(c => `<td>${inline(c.trim())}</td>`).join('') + '</tr>';
    }
    out += '</tbody></table>\n';
  } else {
    out += tableRows.map(r => `<p>${inline(r.join(' | '))}</p>`).join('\n');
  }
  inTable = false;
  tableRows = [];
}

for (const rawLine of lines) {
  const line = rawLine.replace(/\r$/, '');

  if (line.startsWith('```')) {
    flushTable();
    closeLists();
    if (!inCode) {
      inCode = true;
      codeLang = line.slice(3).trim();
      out += `<pre><code class="lang-${esc(codeLang)}">`;
    } else {
      inCode = false;
      out += '</code></pre>\n';
    }
    continue;
  }

  if (inCode) {
    out += esc(line) + '\n';
    continue;
  }

  if (/^\|.*\|$/.test(line.trim())) {
    closeLists();
    inTable = true;
    const cells = line.trim().slice(1, -1).split('|');
    tableRows.push(cells);
    continue;
  }
  if (inTable) flushTable();

  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) {
    closeLists();
    const level = h[1].length;
    out += `<h${level}>${inline(h[2].trim())}</h${level}>\n`;
    continue;
  }

  const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
  if (ol) {
    if (!inOl) { closeLists(); out += '<ol>\n'; inOl = true; }
    out += `<li>${inline(ol[2])}</li>\n`;
    continue;
  }

  const ul = line.match(/^\s*-\s+(.*)$/);
  if (ul) {
    if (!inUl) { closeLists(); out += '<ul>\n'; inUl = true; }
    out += `<li>${inline(ul[1])}</li>\n`;
    continue;
  }

  if (line.trim() === '') {
    closeLists();
    out += '<div class="spacer"></div>\n';
    continue;
  }

  closeLists();
  out += `<p>${inline(line)}</p>\n`;
}

flushTable();
closeLists();

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Long-Term Memory Report (Combined)</title>
  <style>
    :root {
      --bg: #f8f9fb;
      --paper: #ffffff;
      --ink: #1f2937;
      --muted: #6b7280;
      --line: #d1d5db;
      --accent: #0f766e;
    }
    body { margin: 0; font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: linear-gradient(180deg,#eef2f7,#f8f9fb 220px); color: var(--ink); }
    .wrap { max-width: 1040px; margin: 24px auto 64px; padding: 0 20px; }
    .card { background: var(--paper); border: 1px solid var(--line); border-radius: 14px; padding: 26px 30px; box-shadow: 0 8px 24px rgba(15,23,42,0.06); }
    h1,h2,h3,h4,h5,h6 { color: #0b1324; margin: 20px 0 10px; }
    h1 { font-size: 34px; border-bottom: 2px solid var(--line); padding-bottom: 10px; }
    h2 { font-size: 26px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
    h3 { font-size: 20px; }
    p { line-height: 1.62; margin: 9px 0; }
    li { margin: 6px 0; line-height: 1.5; }
    code { background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 6px; padding: 1px 6px; font-size: .92em; }
    pre { background: #0f172a; color: #e5e7eb; border-radius: 10px; padding: 14px 16px; overflow: auto; border: 1px solid #1f2937; }
    pre code { background: transparent; border: none; padding: 0; color: inherit; }
    table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 14px; }
    th, td { border: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .spacer { height: 7px; }
    .banner { color: var(--muted); margin-bottom: 10px; font-size: 14px; }
    @media (max-width: 820px) { .card { padding: 18px; } h1 { font-size: 28px; } h2 { font-size: 22px; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="banner">Combined report generated from docs sources in this repository.</div>
    <article class="card">
${out}
    </article>
  </div>
</body>
</html>`;

fs.writeFileSync(outputPath, html);
console.log(`Wrote ${outputPath}`);
