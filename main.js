const fs = require("node:fs");
const path = require("node:path");
const log = require("electron-log/main");
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
} = require("electron");

const isDevelopment = !app.isPackaged || process.env.NODE_ENV === "development";
const startupMode = process.argv.includes("--hidden") || process.argv.includes("--start-minimized")
  ? "hidden"
  : "normal";
const LOG_MAX_SIZE_BYTES = 2 * 1024 * 1024;
const LOG_ARCHIVE_COUNT = 3;
const LOG_LEVELS = new Set(["error", "warn", "info", "verbose", "debug", "silly"]);
const LOG_CATEGORIES = new Set(["app", "print", "error"]);

let mainWindow;
let tray;
let isQuitting = false;
let lastPrinterSnapshot = "";
const printWindows = new Set();
let appLogger;
let printLogger;
let errorLogger;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  initializeLogging();
  installProcessCrashHandlers();
  logApp("info", "process_start", {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    startupMode,
  });

  app.on("second-instance", (_event, _commandLine, workingDirectory) => {
    logApp("warn", "second_instance_detected", { workingDirectory });
    restoreMainWindow();
  });
}

function initializeLogging() {
  appLogger = createFileLogger("app", "app.log");
  printLogger = createFileLogger("print", "print.log");
  errorLogger = createFileLogger("error", "error.log");
}

function createFileLogger(logId, fileName) {
  const logger = log.create({ logId });
  const logPath = path.join(getLogsDirectory(), fileName);

  fs.closeSync(fs.openSync(logPath, "a"));

  logger.transports.file.resolvePathFn = () => logPath;
  logger.transports.file.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}";
  logger.transports.file.maxSize = LOG_MAX_SIZE_BYTES;
  logger.transports.file.archiveLogFn = rotateLogFile;
  logger.transports.console.level = isDevelopment ? "debug" : false;

  if (logger.transports.remote) {
    logger.transports.remote.level = false;
  }

  return logger;
}

function getLogsDirectory() {
  const logsDirectory = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logsDirectory, { recursive: true });
  return logsDirectory;
}

function rotateLogFile(file) {
  const filePath = file.toString();
  const parsedPath = path.parse(filePath);

  for (let index = LOG_ARCHIVE_COUNT - 1; index >= 1; index -= 1) {
    const currentPath = path.join(parsedPath.dir, `${parsedPath.name}.${index}${parsedPath.ext}`);
    const nextPath = path.join(parsedPath.dir, `${parsedPath.name}.${index + 1}${parsedPath.ext}`);

    if (fs.existsSync(currentPath)) {
      safeRename(currentPath, nextPath);
    }
  }

  if (fs.existsSync(filePath)) {
    safeRename(filePath, path.join(parsedPath.dir, `${parsedPath.name}.1${parsedPath.ext}`));
  }
}

function safeRename(sourcePath, targetPath) {
  try {
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { force: true });
    }

    fs.renameSync(sourcePath, targetPath);
  } catch (error) {
    errorLogger.error(formatLogMessage("error", "log_rotation_failed", { sourcePath, targetPath, error }));
  }
}

function writeDiagnosticLog(category, level, event, details = {}) {
  if (!appLogger || !printLogger || !errorLogger) {
    return;
  }

  const safeCategory = LOG_CATEGORIES.has(category) ? category : "app";
  const safeLevel = LOG_LEVELS.has(level) ? level : "info";
  const safeEvent = String(event || "event").replace(/[^a-z0-9_.:-]/gi, "_");
  const message = formatLogMessage(safeCategory, safeEvent, details);
  const targetLogger = safeCategory === "print" ? printLogger : safeCategory === "error" ? errorLogger : appLogger;

  targetLogger[safeLevel](message);

  if (safeLevel === "error" && safeCategory !== "error") {
    errorLogger.error(message);
  }
}

function logApp(level, event, details = {}) {
  writeDiagnosticLog("app", level, event, details);
}

function logPrint(level, event, details = {}) {
  writeDiagnosticLog("print", level, event, details);
}

function logError(event, details = {}) {
  writeDiagnosticLog("error", "error", event, details);
}

function formatLogMessage(category, event, details = {}) {
  const safeDetails = sanitizeLogDetails(details);
  const detailsText = Object.keys(safeDetails).length ? ` details=${JSON.stringify(safeDetails)}` : "";
  return `category=${category} event=${event}${detailsText}`;
}

function sanitizeLogDetails(value, depth = 0, key = "") {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    if (isSensitiveKey(key)) {
      return "[redacted]";
    }

    if (isUrlKey(key)) {
      return sanitizeUrlForLog(value);
    }

    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= 3) {
      return `[array:${value.length}]`;
    }

    return value.slice(0, 25).map((item) => sanitizeLogDetails(item, depth + 1, key));
  }

  if (typeof value === "object") {
    if (depth >= 3) {
      return "[object]";
    }

    return Object.entries(value).reduce((result, [entryKey, entryValue]) => {
      if (isSensitiveKey(entryKey)) {
        result[entryKey] = "[redacted]";
        return result;
      }

      if (entryKey.toLowerCase().includes("html") || entryKey.toLowerCase() === "content") {
        result[entryKey] = "[omitted]";
        return result;
      }

      result[entryKey] = sanitizeLogDetails(entryValue, depth + 1, entryKey);
      return result;
    }, {});
  }

  return String(value);
}

function isSensitiveKey(key) {
  const normalizedKey = String(key || "").toLowerCase();
  return ["token", "secret", "password", "authorization", "apikey", "publishablekey"].some((term) =>
    normalizedKey.includes(term),
  );
}

function isUrlKey(key) {
  return String(key || "").toLowerCase().includes("url");
}

function sanitizeUrlForLog(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }
}

function installProcessCrashHandlers() {
  process.on("uncaughtException", (error) => {
    logError("uncaught_exception", { error });
  });

  process.on("unhandledRejection", (reason) => {
    logError("unhandled_rejection", { reason });
  });

  process.on("warning", (warning) => {
    logApp("warn", "process_warning", { warning });
  });
}

function createTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="7" fill="#111827"/>
    <path fill="#ffffff" d="M9 7h14v7H9z"/>
    <path fill="#ffffff" d="M8 14h16a3 3 0 0 1 3 3v6h-5v3H10v-3H5v-6a3 3 0 0 1 3-3Zm5 8v2h6v-2Zm10-5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>
  </svg>`;

  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

function createTray() {
  if (tray) {
    return tray;
  }

  tray = new Tray(createTrayIcon());
  tray.setToolTip("DALMAGO Print Agent");
  tray.setContextMenu(buildTrayMenu());
  tray.on("double-click", restoreMainWindow);
  logApp("info", "tray_initialized");
  return tray;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Abrir",
      click: restoreMainWindow,
    },
    {
      label: "Reiniciar polling",
      click: restartPolling,
    },
    {
      label: "Ver status",
      click: showStatusDialog,
    },
    { type: "separator" },
    {
      label: "Sair",
      click: quitFromTray,
    },
  ]);
}

function restoreMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    logApp("info", "window_restore_create");
    createWindow({ show: true });
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
  logApp("info", "window_restored", {
    wasMinimized: mainWindow.isMinimized(),
    visible: mainWindow.isVisible(),
  });
}

function sendRendererCommand(command, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  mainWindow.webContents.send("print-agent:lifecycle-command", {
    command,
    payload,
  });
  return true;
}

function restartPolling() {
  logApp("info", "tray_restart_polling_requested");
  restoreMainWindow();
  sendRendererCommand("restart-polling");
}

function showStatusDialog() {
  const status = getAppStatus();
  logApp("info", "tray_status_requested", status);

  dialog.showMessageBox({
    type: "info",
    title: "DALMAGO Print Agent",
    message: "Status do Print Agent",
    detail: [
      `Versao: ${status.version}`,
      `Janela: ${status.windowVisible ? "visivel" : "oculta"}`,
      `Tray: ${status.trayVisible ? "ativo" : "inativo"}`,
      `Inicializacao: ${status.startupMode}`,
      `Autostart: ${status.autostartEnabled ? "ativo" : "inativo"}`,
    ].join("\n"),
    buttons: ["OK"],
  });
}

function quitFromTray() {
  logApp("info", "tray_quit_requested");
  isQuitting = true;
  sendRendererCommand("shutdown");
  app.quit();
}

function configureAutoStart() {
  if (process.platform !== "win32") {
    logApp("info", "autostart_skipped", { platform: process.platform });
    return;
  }

  try {
    app.setLoginItemSettings(getLoginItemOptions(true));
    logApp("info", "autostart_configured", getAppStatus());
  } catch (error) {
    logError("autostart_configuration_failed", { error });
  }
}

function getLoginItemOptions(openAtLogin) {
  const args = app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"];

  return {
    openAtLogin,
    path: process.execPath,
    args,
  };
}

function getAppStatus() {
  const loginSettings = process.platform === "win32"
    ? app.getLoginItemSettings(getLoginItemOptions(true))
    : { openAtLogin: false };

  return {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    startupMode,
    trayVisible: Boolean(tray),
    windowVisible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    autostartEnabled: Boolean(loginSettings.openAtLogin),
  };
}

function createWindow(options = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (options.show) {
      restoreMainWindow();
    }
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    show: options.show !== false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  logApp("info", "window_created", { show: options.show !== false });
  attachWindowDiagnostics(mainWindow, "main");

  mainWindow.loadFile(path.join(__dirname, "index.html")).catch((error) => {
    logError("renderer_load_failed", { error });
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
    logApp("info", "window_hidden_to_tray");
  });

  mainWindow.on("closed", () => {
    logApp("info", "window_closed");
    mainWindow = null;
  });

  if (isDevelopment) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  return mainWindow;
}

function attachWindowDiagnostics(window, role) {
  window.webContents.on("did-finish-load", () => {
    logApp("info", "renderer_load_success", { role });
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    logError("renderer_did_fail_load", {
      role,
      errorCode,
      errorDescription,
      validatedUrl,
    });
  });

  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    logError("renderer_preload_error", { role, preloadPath, error });
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    logError("renderer_process_gone", { role, details });

    if (role === "main") {
      scheduleRendererRecovery();
    }
  });

  window.webContents.on("unresponsive", () => {
    logApp("warn", "renderer_unresponsive", { role });
  });

  window.webContents.on("responsive", () => {
    logApp("info", "renderer_responsive", { role });
  });
}

function scheduleRendererRecovery() {
  if (isQuitting) {
    return;
  }

  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || isQuitting) {
      return;
    }

    logApp("warn", "renderer_recovery_reload");
    mainWindow.reload();
  }, 1000);
}

function sanitizePrinter(printer) {
  return {
    name: printer.name,
    displayName: printer.displayName || printer.name,
    description: printer.description || "",
    isDefault: Boolean(printer.isDefault),
    status: printer.status ?? null,
    options: printer.options || {},
  };
}

async function getPrinters() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    logPrint("warn", "printer_discovery_skipped", { reason: "main_window_unavailable" });
    return [];
  }

  try {
    const printers = await mainWindow.webContents.getPrintersAsync();
    const sanitizedPrinters = printers.map(sanitizePrinter);
    logPrinterDiscovery(sanitizedPrinters);
    return sanitizedPrinters;
  } catch (error) {
    logError("printer_discovery_failed", { error });
    throw error;
  }
}

function logPrinterDiscovery(printers) {
  const snapshot = printers
    .map((printer) => `${printer.name}:${printer.isDefault}:${printer.status}`)
    .sort()
    .join("|");

  if (snapshot === lastPrinterSnapshot) {
    return;
  }

  lastPrinterSnapshot = snapshot;

  logPrint("info", "printer_discovery", {
    count: printers.length,
    defaultPrinter: printers.find((printer) => printer.isDefault)?.name || "",
    bluetoothCandidates: printers.filter(isBluetoothPrinter).map((printer) => printer.name),
  });
}

function isBluetoothPrinter(printer) {
  const text = [
    printer.name,
    printer.displayName,
    printer.description,
    JSON.stringify(printer.options || {}),
  ]
    .join(" ")
    .toLowerCase();

  return ["bluetooth", " bt ", "ble", "58mm", "pos-58", "thermal"].some((term) => text.includes(term));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildFallbackHtml(job) {
  const lines = Array.isArray(job.lines) ? job.lines : [];

  if (lines.length) {
    return lines.map((line) => `<div>${escapeHtml(line)}</div>`).join("");
  }

  return `<pre>${escapeHtml(JSON.stringify(job, null, 2))}</pre>`;
}

function buildPrintDocument(payload) {
  const job = payload.job || {};
  const html = payload.html || job.html || job.contentHtml || buildFallbackHtml(job);
  const isThermal = String(payload.type || job.type || "").toLowerCase() === "thermal";
  const paperWidth = Number(payload.paperWidth || job.paper_width || 80);
  const pageWidth = isThermal ? `${paperWidth}mm` : "210mm";
  const pageMargin = isThermal ? "3mm" : "12mm";
  const fontSize = isThermal ? "12px" : "14px";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page {
        size: ${isThermal ? `${paperWidth}mm auto` : "A4"};
        margin: ${pageMargin};
      }

      * {
        box-sizing: border-box;
      }

      body {
        width: ${pageWidth};
        margin: 0;
        color: #000;
        background: #fff;
        font-family: Arial, Helvetica, sans-serif;
        font-size: ${fontSize};
      }

      img, svg, canvas {
        max-width: 100%;
      }

      pre {
        white-space: pre-wrap;
        word-break: break-word;
      }
    </style>
  </head>
  <body>${html}</body>
</html>`;
}

function printWebContents(webContents, options) {
  return new Promise((resolve, reject) => {
    webContents.print(options, (success, failureReason) => {
      if (success) {
        resolve({ success: true });
        return;
      }

      reject(new Error(failureReason || "PRINT_FAILED"));
    });
  });
}

function createPrintWindow() {
  const printWindow = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  printWindows.add(printWindow);
  attachWindowDiagnostics(printWindow, "print");
  logPrint("info", "print_window_created", { activePrintWindows: printWindows.size });

  printWindow.on("closed", () => {
    printWindows.delete(printWindow);
    logPrint("info", "print_window_closed", { activePrintWindows: printWindows.size });
  });

  return printWindow;
}

async function printHtml(payload) {
  const printContext = getPrintPayloadSummary(payload, "html");
  logPrint("info", "html_print_start", printContext);
  const printWindow = createPrintWindow();

  try {
    const html = buildPrintDocument(payload);
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    await printWebContents(printWindow.webContents, {
      silent: payload.silent !== false,
      deviceName: payload.printerName,
      printBackground: true,
      copies: Math.max(1, Number(payload.copies || 1)),
      margins: { marginType: "none" },
    });

    logPrint("info", "html_print_success", printContext);
    return { success: true };
  } catch (error) {
    logPrint("error", "html_print_failure", { ...printContext, error });
    throw error;
  } finally {
    if (!printWindow.isDestroyed()) {
      printWindow.close();
    }
  }
}

async function printPdf(payload) {
  if (!payload.url && !payload.dataUrl) {
    logPrint("error", "pdf_print_source_missing", getPrintPayloadSummary(payload, "pdf"));
    throw new Error("PDF_SOURCE_MISSING");
  }

  const printContext = getPrintPayloadSummary(payload, "pdf");
  logPrint("info", "pdf_print_start", printContext);
  const printWindow = createPrintWindow();

  try {
    await printWindow.loadURL(payload.dataUrl || payload.url);

    await printWebContents(printWindow.webContents, {
      silent: payload.silent !== false,
      deviceName: payload.printerName,
      printBackground: true,
      copies: Math.max(1, Number(payload.copies || 1)),
    });

    logPrint("info", "pdf_print_success", printContext);
    return { success: true };
  } catch (error) {
    logPrint("error", "pdf_print_failure", { ...printContext, error });
    throw error;
  } finally {
    if (!printWindow.isDestroyed()) {
      printWindow.close();
    }
  }
}

function getPrintPayloadSummary(payload = {}, format) {
  const job = payload.job || {};

  return {
    format,
    jobId: job.id || job.print_job_id || job.jobId || job._localId || "",
    printerName: payload.printerName || "",
    type: payload.type || job.type || "",
    copies: Math.max(1, Number(payload.copies || 1)),
    silent: payload.silent !== false,
    hasHtml: Boolean(payload.html || job.html || job.contentHtml || job.content || Array.isArray(job.lines)),
    hasPdfUrl: Boolean(payload.url || job.pdf_url || job.pdfUrl || job.document_url || job.url),
    hasPdfDataUrl: Boolean(payload.dataUrl || job.pdf_data_url || job.pdfDataUrl),
    url: payload.url || job.pdf_url || job.pdfUrl || job.document_url || job.url || "",
  };
}

function cleanupBeforeQuit() {
  logApp("info", "app_shutdown_started", {
    activePrintWindows: printWindows.size,
  });
  isQuitting = true;
  sendRendererCommand("shutdown");

  for (const printWindow of printWindows) {
    if (!printWindow.isDestroyed()) {
      printWindow.close();
    }
  }
}

function writeRendererLog(payload = {}) {
  const category = typeof payload.category === "string" ? payload.category : "app";
  const level = typeof payload.level === "string" ? payload.level : "info";
  const event = typeof payload.event === "string" ? payload.event : "renderer_event";
  const details = payload.details && typeof payload.details === "object" ? payload.details : {};

  writeDiagnosticLog(category, level, event, {
    source: "renderer",
    ...details,
  });

  return { success: true };
}

ipcMain.handle("print-agent:get-printers", getPrinters);
ipcMain.handle("print-agent:print-html", (_event, payload) => printHtml(payload || {}));
ipcMain.handle("print-agent:print-pdf", (_event, payload) => printPdf(payload || {}));
ipcMain.handle("print-agent:get-app-status", getAppStatus);
ipcMain.handle("print-agent:write-log", (_event, payload) => writeRendererLog(payload || {}));

app.whenReady().then(() => {
  logApp("info", "app_ready", getAppStatus());
  configureAutoStart();
  createTray();
  createWindow({ show: startupMode !== "hidden" });
  logApp("info", "app_startup_complete", getAppStatus());
}).catch((error) => {
  logError("app_ready_failed", { error });
});

app.on("before-quit", cleanupBeforeQuit);

app.on("child-process-gone", (_event, details) => {
  logError("child_process_gone", { details });
});

app.on("gpu-process-crashed", (_event, killed) => {
  logError("gpu_process_crashed", { killed });
});

app.on("window-all-closed", () => {
  logApp("info", "window_all_closed", { isQuitting });

  if (process.platform === "darwin" && isQuitting) {
    app.quit();
  }
});

app.on("activate", () => {
  logApp("info", "app_activate");
  restoreMainWindow();
});
