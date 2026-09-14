const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("idoDesktop", {
  pickDirectory: () => ipcRenderer.invoke("ido:pick-directory"),
  checkUpdate: () => ipcRenderer.invoke("ido:check-update"),
  openReleases: () => ipcRenderer.invoke("ido:open-releases"),
});
