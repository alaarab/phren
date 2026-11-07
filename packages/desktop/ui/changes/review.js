// Phone DiffReviewLedger: identity is checkout + path + stage, content is SHA-256.
const KEY = 'phren.desktop.changes.reviewed.v1';
const LIMIT = 1_048_576;
export async function fingerprint(patch) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(patch));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export async function reviewItem(checkout, file, section, diffTruncated = false) {
  const reviewable = typeof section?.patch === 'string' && !diffTruncated && !section.truncated && section.loadState !== 'truncated';
  return { key: [checkout, file.path, file.staged ? 'staged' : 'unstaged'].join('\x01'),
    fingerprint: reviewable ? await fingerprint(section.patch) : null };
}
export function createLedger(storage) {
  let marks = {}, lastRaw;
  const read = () => {
    try {
      storage ??= globalThis.localStorage;
      if (!storage) return;
      const raw = storage.getItem(KEY);
      if (raw === lastRaw) return;
      lastRaw = raw;
      if (!raw) { marks = {}; return; }
      if (new TextEncoder().encode(raw).length > LIMIT) return;
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value))
        marks = Object.fromEntries(Object.entries(value).filter(([k, v]) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)));
    } catch { /* private storage or malformed data */ }
  };
  const reviewed = item => { read(); return !!item?.fingerprint && marks[item.key] === item.fingerprint; };
  return {
    reviewed,
    count: items => items.filter(reviewed).length,
    next(after, items) {
      if (after < 0 || after >= items.length) return null;
      for (let step = 1; step < items.length; step++) {
        const i = (after + step) % items.length;
        if (!reviewed(items[i])) return i;
      }
      return null;
    },
    toggle(item) {
      if (!item?.fingerprint) return;
      const had = reviewed(item);
      delete marks[item.key];
      if (!had) marks[item.key] = item.fingerprint;
      // Evict oldest insertions; never let a viewer's history grow without bound.
      while (new TextEncoder().encode(JSON.stringify(marks)).length > LIMIT) delete marks[Object.keys(marks)[0]];
      try { const raw = JSON.stringify(marks); storage?.setItem(KEY, raw); lastRaw = raw; } catch { /* private storage */ }
    },
  };
}
