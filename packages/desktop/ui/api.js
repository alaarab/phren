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
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
}

/** GET a Hook route with query parameters (an object). */
export async function hookGet(computer, route, query = {}) {
  const search = new URLSearchParams(query).toString();
  return parse(await fetch(base(computer) + route + (search ? `?${search}` : "")));
}

/** Read a whole text file of the session's repository: {text, version, total}. */
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
  return { text: new TextDecoder().decode(bytes), version, total };
}
