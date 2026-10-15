import { quotaPreferences } from "./quota-warn.js";
const KEY = "phren.desktop.quota-warning";
const CHATS = "phren.desktop.quota-warning-chats";
const SEEN = "phren.desktop.quota-warning-seen";
const memory = new Map();
function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? memory.get(key) ?? fallback; }
  catch { return memory.get(key) ?? fallback; }
}
function save(key, value) {
  memory.set(key, value);
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* keep this session's choice */ }
}
export function quotaSettings() { return quotaPreferences(read(KEY, {})); }
export function saveQuotaSettings(next) { save(KEY, quotaPreferences({ ...quotaSettings(), ...next })); }
export function quotaSuppressed() { const value = read(CHATS, []); return Array.isArray(value) ? value : []; }
export function suppressQuotaChat(key) { save(CHATS, [...new Set([...quotaSuppressed(), key])]); }
export function quotaSeen() { const value = read(SEEN, []); return Array.isArray(value) ? value : []; }
export function markQuotaSeen(token) { save(SEEN, [...new Set([...quotaSeen(), token])]); }
