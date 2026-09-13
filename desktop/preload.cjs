const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "idoDesktop",
  Object.freeze({
    request: (path, input) => ipcRenderer.invoke("ido:request", path, input),
    quit: () => ipcRenderer.invoke("ido:quit"),
    openExternal: (url) => ipcRenderer.invoke("ido:external", url),
  }),
);
