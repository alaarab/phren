// Small DOM and request helpers shared by the Settings pages.
export async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { "X-Phren-Desktop": "1", ...(options.headers || {}) };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 300) }; }
  if (!res.ok) {
    const error = new Error(body.error || `Request failed (${res.status}).`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

export const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function input(placeholder, className) {
  const field = document.createElement("input");
  field.type = "text";
  field.className = className ? `settings-input ${className}` : "settings-input";
  field.placeholder = placeholder;
  field.setAttribute("aria-label", placeholder);
  return field;
}

export function button(label, kind) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = kind ? `settings-btn ${kind}` : "settings-btn";
  b.textContent = label;
  return b;
}

/** A small-caps heading with an optional live count span. Returns [heading, count]. */
export function heading(label) {
  const h = el("h2", "section-label settings-heading");
  h.append(document.createTextNode(label));
  const count = el("span", "settings-count");
  h.append(count);
  return [h, count];
}

export function noticeLine() {
  const line = el("div", "settings-notice");
  line.hidden = true;
  return line;
}

export function showNotice(line, text, danger) {
  line.textContent = text;
  line.className = danger ? "settings-notice settings-error" : "settings-notice";
  line.hidden = !text;
}

/** A labelled switch row. */
export function toggleRow(labelText, checked, onChange) {
  const row = el("label", "settings-toggle");
  row.append(el("span", "settings-toggle-label", labelText));
  const control = el("span", "settings-switch");
  const field = document.createElement("input");
  field.type = "checkbox";
  field.checked = checked;
  field.addEventListener("change", () => onChange(field.checked));
  control.append(field, el("span", "track"));
  row.append(control);
  return row;
}
