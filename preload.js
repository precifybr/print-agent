const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("printAssistant", {
  getStatus: () => ipcRenderer.invoke("print-agent:get-status"),
  printTest: (payload) => ipcRenderer.invoke("print-agent:print-test", payload),
  checkForUpdates: () => ipcRenderer.invoke("print-agent:check-for-updates"),
  installUpdate: () => ipcRenderer.invoke("print-agent:install-update"),
  quit: () => ipcRenderer.invoke("print-agent:quit"),
});
