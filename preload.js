const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("printAgent", {
  getPrinters: () => ipcRenderer.invoke("print-agent:get-printers"),
  printHtml: (payload) => ipcRenderer.invoke("print-agent:print-html", payload),
  printPdf: (payload) => ipcRenderer.invoke("print-agent:print-pdf", payload),
  getLocalBridgeStatus: () => ipcRenderer.invoke("print-agent:get-local-bridge-status"),
  getLocalSettings: () => ipcRenderer.invoke("print-agent:get-local-settings"),
  updateLocalSettings: (payload) => ipcRenderer.invoke("print-agent:update-local-settings", payload),
  printLocal: (payload) => ipcRenderer.invoke("print-agent:print-local", payload),
  getAppStatus: () => ipcRenderer.invoke("print-agent:get-app-status"),
  writeLog: (payload) => ipcRenderer.invoke("print-agent:write-log", payload),
  onLifecycleCommand: (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }

    const listener = (_event, message = {}) => {
      const command = typeof message.command === "string" ? message.command : "";
      const payload = message.payload && typeof message.payload === "object" ? message.payload : {};

      if (["restart-polling", "shutdown"].includes(command)) {
        callback({ command, payload });
      }
    };

    ipcRenderer.on("print-agent:lifecycle-command", listener);
    return () => ipcRenderer.removeListener("print-agent:lifecycle-command", listener);
  },
});
