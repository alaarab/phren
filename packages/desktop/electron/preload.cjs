const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("phrenDesktop", {
  platform: process.platform,
  setBadge: (n) => ipcRenderer.send("phren:badge", n),
  notify: (title, body, opts) => ipcRenderer.send("phren:notify", { title: String(title), body: String(body), key: opts?.key ? String(opts.key) : "", reply: opts?.reply === true }),
  onReply: (fn) => ipcRenderer.on("phren:reply", (_event, payload) => fn({ key: String(payload?.key ?? ""), text: String(payload?.text ?? "") })),
  setSummonKey: (accel) => ipcRenderer.invoke("phren:summon-key", String(accel ?? "")),
  onSummon: (fn) => ipcRenderer.on("phren:summon", () => fn()),
  setTray: (state) => ipcRenderer.send("phren:tray", state),
  onOpenSession: (fn) => ipcRenderer.on("phren:open-session", (_event, key) => fn(String(key))),
});
