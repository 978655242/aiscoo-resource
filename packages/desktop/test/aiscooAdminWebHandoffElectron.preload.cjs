const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("nativeHandoffTest", {
  prepare: (request) => ipcRenderer.invoke("zcode:native-plan-webview-prepare", request),
});
