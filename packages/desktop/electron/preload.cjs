const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("phrenDesktop", {
  platform: process.platform,
  setBadge: (n) => ipcRenderer.send("phren:badge", n),
  notify: (title, body) => ipcRenderer.send("phren:notify", { title: String(title), body: String(body) }),
});
