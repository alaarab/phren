// Same-origin calls to a computer's Hook through the desktop daemon's /hosts proxy.
// The token cookie is already set; every call names the computer.

const base = (computer) => `/hosts/${encodeURIComponent(computer)}`;

/** A target as URL query parameters (the Hook's GET routes read it this way). */
export function targetQuery(target) {
  return new URLSearchParams(target).toString();
}

async function parse(response) {
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 300) }; }
  if (!response.ok) {
    const error = new Error(body.error || `The Hook answered ${response.status}.`);
    error.status = response.status;
    error.code = body.code;
    error.body = body;
    throw error;
  }
  return body;
}

/** POST a JSON body to a Hook route ("/v1/git/status"). Throws Error{status, code, body} on non-2xx. */
export async function hookPost(computer, route, body) {
  return parse(await fetch(base(computer) + route, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Phren-Desktop": "1" }, body: JSON.stringify(body),
  }));
}

/** GET a Hook route with query parameters (an object). */
export async function hookGet(computer, route, query = {}) {
  const search = new URLSearchParams(query).toString();
  return parse(await fetch(base(computer) + route + (search ? `?${search}` : "")));
}

/** Read a whole text file of the session's repository: {text, version, total}.
 * Decodes once over the concatenated bytes as strict UTF-8, so a multi-byte
 * character split across pages survives and invalid bytes surface as a decode
 * error instead of silent U+FFFD. `bom` marks a leading UTF-8 BOM (kept out of
 * `text`); `binary` marks bytes that are not UTF-8 (`text` is then empty). */
export async function readRepoFile(computer, target, path) {
  const chunks = [];
  let offset = 0, version, total = 0;
  for (;;) {
    const page = await hookGet(computer, "/v1/files/range", { ...target, path, offset: String(offset), ...(version ? { version } : {}) });
    version = page.version; total = page.total;
    chunks.push(Uint8Array.from(atob(page.data), (c) => c.charCodeAt(0)));
    offset += page.length;
    if (page.eof || page.length === 0) break;
  }
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0; for (const c of chunks) { bytes.set(c, at); at += c.length; }
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text = "", binary = false;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (bom) text = text.slice(1);
  } catch { binary = true; }
  return { text, bom, binary, version, total };
}
