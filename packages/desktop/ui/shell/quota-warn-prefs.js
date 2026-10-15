import { quotaPreferences } from "./quota-warn.js";
const ROUTE = "/api/settings/quota-warning";
const SEEN_LIMIT = 512;
let state = { settings: quotaPreferences(), suppressed: [], seen: [] };
let loading = null;
let loaded = false;
let writes = Promise.resolve();
async function request(update) {
  const response = await fetch(ROUTE, update ? {
    method: "POST", headers: { "Content-Type": "application/json", "X-Phren-Desktop": "1" }, body: JSON.stringify(update),
  } : { cache: "no-store" });
  if (!response.ok) throw new Error("Could not save or load account warning preferences.");
  return response.json();
}
/** Hydrate before deciding or editing; failed reads can be retried. */
export function loadQuotaState() {
  if (loaded) return Promise.resolve();
  if (!loading) loading = request().then((value) => {
    state = { settings: quotaPreferences(value.settings), suppressed: value.suppressed ?? [], seen: (value.seen ?? []).slice(-SEEN_LIMIT) };
    loaded = true;
  }).finally(() => { loading = null; });
  return loading;
}
function update(change, apply) {
  const mutate = () => {
    apply();
    const saved = writes.catch(() => {}).then(() => request(change));
    writes = saved;
    return saved;
  };
  return loaded ? mutate() : loadQuotaState().then(mutate);
}
export function quotaSettings() { return state.settings; }
export function saveQuotaSettings(next) {
  // Resolve the merge after hydration as well, so editing one value retains the other.
  return loadQuotaState().then(() => update({ settings: quotaPreferences({ ...quotaSettings(), ...next }) }, () => { state.settings = quotaPreferences({ ...quotaSettings(), ...next }); }));
}
export function quotaSuppressed() { return state.suppressed; }
export function suppressQuotaChat(key) { return update({ suppress: key }, () => { state.suppressed = [...new Set([...state.suppressed, key])]; }); }
export function quotaSeen() { return state.seen; }
export function markQuotaSeen(token) { return update({ markSeen: token }, () => { state.seen = [...state.seen.filter((t) => t !== token), token].slice(-SEEN_LIMIT); }); }
export function unmarkQuotaSeen(token) { return update({ unmarkSeen: token }, () => { state.seen = state.seen.filter((t) => t !== token); }); }
