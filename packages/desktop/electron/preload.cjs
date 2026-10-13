const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("phrenDesktop", {
  platform: process.platform,
  setBadge: (n) => ipcRenderer.send("phren:badge", n),
  notify: (title, body) => ipcRenderer.send("phren:notify", { title: String(title), body: String(body) }),
  setSummonKey: (accel) => ipcRenderer.invoke("phren:summon-key", String(accel ?? "")),
  onSummon: (fn) => ipcRenderer.on("phren:summon", () => fn()),
});
