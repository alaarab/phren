const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("phrenDesktop", {
  platform: process.platform,
  version: process.argv.find((arg) => arg.startsWith("--phren-desktop-version="))?.slice("--phren-desktop-version=".length),
  setBadge: (n) => ipcRenderer.send("phren:badge", n),
  notify: (title, body, opts) => ipcRenderer.send("phren:notify", { title: String(title), body: String(body), key: opts?.key ? String(opts.key) : "", reply: opts?.reply === true, binding: opts?.binding }),
  onReply: (fn) => ipcRenderer.on("phren:reply", (_event, payload) => fn({ key: String(payload?.key ?? ""), text: String(payload?.text ?? ""), binding: payload?.binding })),
  setSummonKey: (accel) => ipcRenderer.invoke("phren:summon-key", String(accel ?? "")),
  onSummon: (fn) => ipcRenderer.on("phren:summon", () => fn()),
  setTray: (state) => ipcRenderer.send("phren:tray", state),
  onNewAgent: (fn) => ipcRenderer.on("phren:new-agent", () => fn()),
  onTrayAnswer: (fn) => ipcRenderer.on("phren:tray-answer", (_event, answer) => fn({ key: String(answer?.key ?? ""), decision: answer?.decision === "approve" ? "approve" : "deny", actionId: String(answer?.actionId ?? "") })),
  onUpdate: (fn) => ipcRenderer.on("phren:update", (_event, state) => fn(state)),
  updateAction: (kind) => ipcRenderer.send("phren:update-action", String(kind)),
  onOpenSession: (fn) => ipcRenderer.on("phren:open-session", (_event, key) => fn(String(key))),
});
