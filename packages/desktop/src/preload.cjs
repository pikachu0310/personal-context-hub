const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("idoDesktop", {
  pickDirectory: () => ipcRenderer.invoke("ido:pick-directory"),
});
