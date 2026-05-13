const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const log = require("electron-log/main");
const { autoUpdater } = require("electron-updater");
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
const LOG_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const LOG_ARCHIVE_COUNT = 3;
const PRINT_TIMEOUT_MS = 30000;
const PRINT_DIALOG_TIMEOUT_MS = 120000;
const PRINT_DIAGNOSTIC_MAX_JOBS = 100;
const PRINT_DIAGNOSTIC_MAX_BYTES = 5 * 1024 * 1024;
const LOG_LEVELS = new Set(["error", "warn", "info", "verbose", "debug", "silly"]);
const LOG_CATEGORIES = new Set(["app", "print", "localhost"]);
const LOCAL_BRIDGE_HOST = "127.0.0.1";
const LOCAL_BRIDGE_PORT = 18181;
const LOCAL_SETTINGS_FILE = "local-bridge-settings.json";
const PAPER_SIZES = new Set(["58mm", "80mm", "A4"]);
const LOCAL_PRINT_WORKER_FLAG = "--local-print-worker";
const LOCAL_REQUEST_MAX_BYTES = 2 * 1024 * 1024;
const DUPLICATE_PRINT_WINDOW_MS = 8000;
const WATCHDOG_INTERVAL_MS = 15000;
const LOCAL_SECTOR_PROFILES = {
  motorista: {
    paperSize: "58mm",
    keywords: ["motorista", "entrega", "delivery", "motoboy", "58", "balcao", "pos"],
  },
  cozinha: {
    paperSize: "80mm",
    keywords: ["cozinha", "kitchen", "expedicao", "80", "hprt", "termica"],
  },
  financeiro: {
    paperSize: "A4",
    keywords: ["financeiro", "a4", "laser", "office", "deskjet", "pdf"],
  },
};

let mainWindow;
let tray;
let isQuitting = false;
let shutdownCleanupDone = false;
let lastPrinterSnapshot = "";
const printWindows = new Set();
let appLogger;
let printLogger;
let localhostLogger;
let localBridgeServer;
let localBridgeListening = false;
let cachedPrinters = [];
let updateStatus = getDefaultUpdateStatus();
let lastPrintDiagnostic = null;
let printDiagnosticHistory = [];
let printQueue = Promise.resolve();
const recentPrintRequests = new Map();
let watchdogTimer = null;
const localBridgeStats = {
  startedAt: new Date().toISOString(),
  requestCount: 0,
  lastRequest: null,
  lastPrint: null,
  lastError: null,
  healthChecks: 0,
  lastHealthCheckAt: null,
};
const isLocalPrintWorker = process.argv.includes(LOCAL_PRINT_WORKER_FLAG);

const gotSingleInstanceLock = isLocalPrintWorker || app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.exit(0);
} else {
  initializeLogging();
  loadPrintDiagnostics();
  installProcessCrashHandlers();
  logApp("info", "process_start", {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    startupMode,
  });

  app.on("second-instance", (_event, commandLine, workingDirectory) => {
    logApp("warn", "second_instance_detected", {
      workingDirectory,
      commandLine: commandLine.join(" "),
    });
    restoreMainWindow();
  });
}

function initializeLogging() {
  appLogger = createFileLogger("app", "app.log");
  printLogger = createFileLogger("print", "print.log");
  localhostLogger = createFileLogger("localhost", "localhost.log");
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

function getLocalSettingsPath() {
  return path.join(app.getPath("userData"), LOCAL_SETTINGS_FILE);
}

function getLocalPrintJobsDirectory() {
  const jobsDirectory = path.join(app.getPath("userData"), "local-print-jobs");
  fs.mkdirSync(jobsDirectory, { recursive: true });
  return jobsDirectory;
}

function getPrintDiagnosticsPath() {
  return path.join(getLogsDirectory(), "print-diagnostics.json");
}

function getDefaultLocalSettings() {
  return {
    preferredPrinter: "",
    paperSize: "80mm",
    autoUpdateEnabled: true,
    sectors: {},
  };
}

function sanitizeLocalSettings(settings = {}) {
  const sectors = settings.sectors && typeof settings.sectors === "object" && !Array.isArray(settings.sectors)
    ? settings.sectors
    : {};

  return {
    preferredPrinter: String(settings.preferredPrinter || "").trim(),
    paperSize: PAPER_SIZES.has(settings.paperSize) ? settings.paperSize : "80mm",
    autoUpdateEnabled: Boolean(settings.autoUpdateEnabled),
    sectors: Object.entries(sectors).reduce((result, [sectorName, printerName]) => {
      const safeSectorName = normalizeSectorName(sectorName);
      const safePrinterName = String(printerName || "").trim();

      if (safeSectorName && safePrinterName) {
        result[safeSectorName] = safePrinterName;
      }

      return result;
    }, {}),
  };
}

function normalizeSectorName(value) {
  return normalizePrinterName(value || "");
}

function readLocalSettings() {
  try {
    const rawSettings = fs.readFileSync(getLocalSettingsPath(), "utf8");
    return sanitizeLocalSettings({
      ...getDefaultLocalSettings(),
      ...JSON.parse(rawSettings),
    });
  } catch {
    return getDefaultLocalSettings();
  }
}

function writeLocalSettings(nextSettings = {}) {
  const settings = sanitizeLocalSettings({
    ...readLocalSettings(),
    ...nextSettings,
  });

  fs.writeFileSync(getLocalSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  logApp("info", "local_settings_saved", {
    hasPreferredPrinter: Boolean(settings.preferredPrinter),
    paperSize: settings.paperSize,
    sectorCount: Object.keys(settings.sectors).length,
    autoUpdateEnabled: settings.autoUpdateEnabled,
  });
  return settings;
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
    if (appLogger) {
      appLogger.error(formatLogMessage("app", "log_rotation_failed", { sourcePath, targetPath, error }));
    }
  }
}

function writeDiagnosticLog(category, level, event, details = {}) {
  if (!appLogger || !printLogger || !localhostLogger) {
    return;
  }

  const safeCategory = LOG_CATEGORIES.has(category) ? category : "app";
  const safeLevel = LOG_LEVELS.has(level) ? level : "info";
  const safeEvent = String(event || "event").replace(/[^a-z0-9_.:-]/gi, "_");
  const message = formatLogMessage(safeCategory, safeEvent, details);
  const targetLogger = safeCategory === "print"
    ? printLogger
    : safeCategory === "localhost"
      ? localhostLogger
      : appLogger;

  targetLogger[safeLevel](message);

  if (safeLevel === "error" && safeCategory !== "app") {
    appLogger.error(message);
  }
}

function logApp(level, event, details = {}) {
  writeDiagnosticLog("app", level, event, details);
}

function logPrint(level, event, details = {}) {
  writeDiagnosticLog("print", level, event, details);
}

function logUpdater(level, event, details = {}) {
  writeDiagnosticLog("app", level, event, details);
}

function logLocalhost(level, event, details = {}) {
  writeDiagnosticLog("localhost", level, event, details);
}

function logError(event, details = {}) {
  writeDiagnosticLog("app", "error", event, details);
}

function loadPrintDiagnostics() {
  try {
    const diagnostics = JSON.parse(fs.readFileSync(getPrintDiagnosticsPath(), "utf8"));
    printDiagnosticHistory = Array.isArray(diagnostics.jobs)
      ? diagnostics.jobs.slice(-PRINT_DIAGNOSTIC_MAX_JOBS)
      : [];
    lastPrintDiagnostic = printDiagnosticHistory[printDiagnosticHistory.length - 1] || null;
  } catch {
    printDiagnosticHistory = [];
    lastPrintDiagnostic = null;
  }
}

function savePrintDiagnostic(trace) {
  if (!trace) {
    return;
  }

  const existingIndex = printDiagnosticHistory.findIndex((job) => job.jobId === trace.jobId);

  if (existingIndex >= 0) {
    printDiagnosticHistory[existingIndex] = trace;
  } else {
    printDiagnosticHistory.push(trace);
  }

  printDiagnosticHistory = printDiagnosticHistory.slice(-PRINT_DIAGNOSTIC_MAX_JOBS);
  lastPrintDiagnostic = trace;

  let payload = JSON.stringify({ jobs: printDiagnosticHistory }, null, 2);

  while (Buffer.byteLength(payload, "utf8") > PRINT_DIAGNOSTIC_MAX_BYTES && printDiagnosticHistory.length > 1) {
    printDiagnosticHistory.shift();
    payload = JSON.stringify({ jobs: printDiagnosticHistory }, null, 2);
  }

  try {
    fs.writeFileSync(getPrintDiagnosticsPath(), `${payload}\n`, "utf8");
  } catch (error) {
    logError("print_diagnostic_save_failed", { error });
  }
}

function createPrintTrace(type, details = {}) {
  const trace = {
    jobId: details.jobId || randomUUID(),
    type,
    requestedPrinter: details.requestedPrinter || "",
    printer: details.printer || "",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    durationMs: 0,
    status: "running",
    steps: [],
    callbacks: [],
    callback: null,
    error: null,
  };

  traceStep(trace, "request_received", true, details);
  return trace;
}

function traceStep(trace, step, ok = true, details = {}) {
  if (!trace) {
    return null;
  }

  const startedAt = Date.parse(trace.startedAt) || Date.now();
  const entry = {
    step,
    ok: Boolean(ok),
    timeMs: Date.now() - startedAt,
    at: new Date().toISOString(),
    details: sanitizeLogDetails(details),
  };

  trace.steps.push(entry);
  logPrint(ok ? "info" : "error", `trace_${step}`, {
    jobId: trace.jobId,
    ...details,
  });
  savePrintDiagnostic(trace);
  return entry;
}

function finishPrintTrace(trace, status, details = {}) {
  if (!trace) {
    return null;
  }

  trace.status = status;
  trace.finishedAt = new Date().toISOString();
  trace.durationMs = Date.now() - (Date.parse(trace.startedAt) || Date.now());

  if (details.error) {
    trace.error = sanitizeLogDetails(details.error);
  } else if (details.message) {
    trace.error = { message: details.message };
  }

  traceStep(trace, "job_finished", status === "success", {
    status,
    durationMs: trace.durationMs,
    error: trace.error,
  });
  savePrintDiagnostic(trace);
  return trace;
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
  const iconPath = path.join(__dirname, "build", "icon.png");

  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }

  return nativeImage.createEmpty();
}

function createTray() {
  if (tray) {
    return tray;
  }

  tray = new Tray(createTrayIcon());
  tray.setToolTip("Print Assistant");
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

function showStatusDialog() {
  const status = getAppStatus();
  logApp("info", "tray_status_requested", status);

  dialog.showMessageBox({
    type: "info",
    title: "Print Assistant",
    message: "Status do Print Agent",
    detail: [
      `Versao: ${status.version}`,
      `Janela: ${status.windowVisible ? "visivel" : "oculta"}`,
      `Tray: ${status.trayVisible ? "ativo" : "inativo"}`,
      `Localhost: ${status.localhostListening ? "online" : "offline"}`,
      `Autostart: ${status.autostartEnabled ? "ativo" : "inativo"}`,
    ].join("\n"),
    buttons: ["OK"],
  });
}

function quitFromTray() {
  logApp("info", "tray_quit_requested");
  requestAppQuit("tray");
}

function requestAppQuit(source = "app") {
  if (isQuitting) {
    return;
  }

  logApp("info", "app_quit_requested", { source });
  isQuitting = true;
  cleanupBeforeQuit();
  app.quit();

  setTimeout(() => {
    if (!app.isReady()) {
      return;
    }

    logApp("warn", "app_quit_force_exit");
    app.exit(0);
  }, 3000).unref();
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
    localhostListening: localBridgeListening,
    host: os.hostname(),
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
    icon: path.join(__dirname, "build", "icon.png"),
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
    cachedPrinters = sanitizedPrinters;
    logPrinterDiscovery(sanitizedPrinters);
    return sanitizedPrinters;
  } catch (error) {
    logError("printer_discovery_failed", { error });
    throw error;
  }
}

function getDefaultPrinter(printers = []) {
  return printers.find((printer) => printer.isDefault) || printers[0] || null;
}

function normalizePrinterName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function findPrinterByNormalizedName(printers, targetName, allowPartial = false) {
  const normalizedTarget = normalizePrinterName(targetName);

  if (!normalizedTarget) {
    return null;
  }

  const exactPrinter = printers.find((printer) => normalizePrinterName(printer.name) === normalizedTarget);

  if (exactPrinter || !allowPartial) {
    return exactPrinter || null;
  }

  return printers.find((printer) => {
    const printerName = normalizePrinterName(printer.name);
    const displayName = normalizePrinterName(printer.displayName);
    return printerName.includes(normalizedTarget) || normalizedTarget.includes(printerName) || displayName.includes(normalizedTarget);
  }) || null;
}

async function resolveLocalPrinter(requestedPrinterName) {
  const printers = cachedPrinters.length ? cachedPrinters : await getPrinters();
  const settings = readLocalSettings();
  const requestedName = String(requestedPrinterName || "").trim();
  const exactPrinter = findPrinterByNormalizedName(printers, requestedName);

  if (exactPrinter) {
    logPrint("info", "printer_resolved", {
      requestedPrinter: requestedName,
      printerName: exactPrinter.name,
      resolvedBy: "exact",
    });
    return {
      printer: exactPrinter,
      printers,
      resolvedBy: "exact",
    };
  }

  const partialPrinter = findPrinterByNormalizedName(printers, requestedName, true);

  if (partialPrinter) {
    logPrint("info", "printer_resolved", {
      requestedPrinter: requestedName,
      printerName: partialPrinter.name,
      resolvedBy: "partial",
    });
    return {
      printer: partialPrinter,
      printers,
      resolvedBy: "partial",
    };
  }

  const preferredPrinter = findPrinterByNormalizedName(printers, settings.preferredPrinter, true);

  if (preferredPrinter) {
    logPrint("warn", "printer_resolved_preferred_fallback", {
      requestedPrinter: requestedName,
      preferredPrinter: settings.preferredPrinter,
      printerName: preferredPrinter.name,
    });
    return {
      printer: preferredPrinter,
      printers,
      resolvedBy: "preferred",
    };
  }

  const defaultPrinter = getDefaultPrinter(printers);

  if (defaultPrinter) {
    logPrint("warn", "printer_resolved_default_fallback", {
      requestedPrinter: requestedName,
      printerName: defaultPrinter.name,
    });
    return {
      printer: defaultPrinter,
      printers,
      resolvedBy: "default",
    };
  }

  return {
    printer: null,
    printers,
    resolvedBy: "missing",
  };
}

function findPrinterByKeyword(printers, keywords = []) {
  for (const keyword of keywords) {
    const match = findPrinterByNormalizedName(printers, keyword, true);

    if (match) {
      return match;
    }
  }

  return null;
}

function resolveSectorAssignment(printers, sectorName, settings = readLocalSettings()) {
  const normalizedSector = normalizeSectorName(sectorName);
  const configuredPrinter = settings.sectors[normalizedSector]
    ? findPrinterByNormalizedName(printers, settings.sectors[normalizedSector], true)
    : null;

  if (configuredPrinter) {
    return {
      printer: configuredPrinter,
      paperSize: LOCAL_SECTOR_PROFILES[normalizedSector]?.paperSize || settings.paperSize,
      resolvedBy: "sector_config",
      sector: normalizedSector,
    };
  }

  const profile = LOCAL_SECTOR_PROFILES[normalizedSector];

  if (profile) {
    const keywordMatch = findPrinterByKeyword(printers, [normalizedSector, ...profile.keywords]);

    if (keywordMatch) {
      return {
        printer: keywordMatch,
        paperSize: profile.paperSize,
        resolvedBy: "sector_keyword",
        sector: normalizedSector,
      };
    }
  }

  return {
    printer: null,
    paperSize: profile?.paperSize || settings.paperSize,
    resolvedBy: "sector_missing",
    sector: normalizedSector,
  };
}

function buildSectorSnapshot(printers, settings = readLocalSettings()) {
  return Object.keys(LOCAL_SECTOR_PROFILES).reduce((result, sectorName) => {
    const assignment = resolveSectorAssignment(printers, sectorName, settings);
    result[sectorName] = {
      printer: assignment.printer?.name || null,
      paperSize: assignment.paperSize,
      resolvedBy: assignment.resolvedBy,
    };
    return result;
  }, {});
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
  const paperSize = payload.paperSize || job.paper_size || "";
  const isThermal = String(payload.type || job.type || "").toLowerCase() === "thermal" || ["58mm", "80mm"].includes(paperSize);
  const paperWidth = Number(payload.paperWidth || job.paper_width || String(paperSize).replace("mm", "") || 80);
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

function buildTextPrintHtml(text) {
  return `<pre>${escapeHtml(text)}</pre>`;
}

function buildOrderPrintHtml(sector, orderPayload) {
  const title = sector ? `SETOR: ${sector.toUpperCase()}\n\n` : "";
  const serializedOrder = typeof orderPayload === "string"
    ? orderPayload
    : JSON.stringify(orderPayload, null, 2);

  return buildTextPrintHtml(`${title}${serializedOrder}`);
}

async function printLocalPayload(payload = {}) {
  const jobId = randomUUID();
  const requestedSector = normalizeSectorName(payload.setor || payload.sector || "");
  const trace = createPrintTrace("local_print", {
    jobId,
    requestedPrinter: payload.printer || payload.printerName || requestedSector || "",
  });
  const settings = readLocalSettings();
  const printers = cachedPrinters.length ? cachedPrinters : await getPrinters();
  const sectorAssignment = requestedSector
    ? resolveSectorAssignment(printers, requestedSector, settings)
    : null;
  const requestedPrinter = payload.printer
    || payload.printerName
    || sectorAssignment?.printer?.name
    || "";
  const printSignature = getPrintRequestSignature(payload, requestedPrinter);
  trace.requestedPrinter = requestedPrinter;
  trace.sector = requestedSector;

  traceStep(trace, "json_validated", true, {
    hasHtml: Boolean(payload.html),
    hasText: typeof payload.text === "string",
    hasPedido: typeof payload.pedido === "object" && payload.pedido !== null,
    sector: requestedSector,
    requestedPrinter,
  });

  if (isDuplicatePrintRequest(printSignature)) {
    logPrint("warn", "local_print_duplicate_rejected", {
      jobId,
      requestedPrinter,
      sector: requestedSector,
    });
    throw createHttpError(409, "DUPLICATE_PRINT_REQUEST");
  }

  traceStep(trace, "windows_printers_lookup_start", true, { requestedPrinter });
  const { printer, resolvedBy } = await resolveLocalPrinter(requestedPrinter);
  const paperSize = PAPER_SIZES.has(payload.paperSize)
    ? payload.paperSize
    : sectorAssignment?.paperSize || settings.paperSize;

  if (!printer) {
    traceStep(trace, "printer_not_found", false, {
      requestedPrinter,
      foundPrinters: cachedPrinters.map((cachedPrinter) => cachedPrinter.name),
    });
    finishPrintTrace(trace, "failure", { message: "NO_PRINTER_AVAILABLE" });
    logPrint("error", "local_print_no_printer_available", {
      jobId,
      requestedPrinter,
    });
    throw createHttpError(503, "NO_PRINTER_AVAILABLE");
  }

  trace.printer = printer.name;
  traceStep(trace, "printer_found", true, {
    requestedPrinter,
    printerName: printer.name,
    resolvedBy,
    sectorResolution: sectorAssignment?.resolvedBy || "",
  });

  if (!payload.html && typeof payload.text !== "string" && !payload.pedido) {
    traceStep(trace, "content_missing", false);
    finishPrintTrace(trace, "failure", { message: "PRINT_CONTENT_MISSING" });
    throw createHttpError(400, "PRINT_CONTENT_MISSING");
  }

  rememberPrintRequest(printSignature);

  const isThermal = ["58mm", "80mm"].includes(paperSize);
  const html = payload.html
    || (typeof payload.text === "string" ? buildTextPrintHtml(payload.text) : buildOrderPrintHtml(requestedSector, payload.pedido));

  logPrint("info", "local_print_dispatch", {
    jobId,
    requestedPrinter,
    sector: requestedSector,
    printerName: printer.name,
    resolvedBy,
    paperSize,
    format: payload.html ? "html" : "text",
  });

  const printPayload = {
    job: {
      id: jobId,
      type: isThermal ? "thermal" : "A4",
    },
    html,
    printerName: printer.name,
    type: isThermal ? "thermal" : "A4",
    paperSize,
    paperWidth: isThermal ? Number(paperSize.replace("mm", "")) : undefined,
    copies: payload.copies,
    silent: isThermal ? true : payload.silent !== false,
    trace,
  };

  startIsolatedPrintJob(printPayload, {
    jobId,
    requestedPrinter,
    sector: requestedSector,
    printerName: printer.name,
    resolvedBy,
    paperSize,
  });

  localBridgeStats.lastPrint = {
    jobId,
    acceptedAt: new Date().toISOString(),
    requestedPrinter,
    sector: requestedSector,
    printerName: printer.name,
    resolvedBy,
    paperSize,
    status: "accepted",
  };
  traceStep(trace, "job_accepted", true, {
    printerName: printer.name,
    silent: printPayload.silent,
    thermalDialogMode: isThermal,
  });

  return {
    success: true,
    accepted: true,
    jobId,
    printer: printer.name,
    requestedPrinter,
    resolvedBy,
    paperSize,
  };
}

function getPrintRequestSignature(payload, requestedPrinter) {
  const content = JSON.stringify({
    printer: requestedPrinter,
    sector: payload.setor || payload.sector || "",
    paperSize: payload.paperSize || "",
    copies: payload.copies || 1,
    html: payload.html || "",
    text: payload.text || "",
    pedido: payload.pedido || null,
  });

  return createHash("sha256").update(content).digest("hex");
}

function isDuplicatePrintRequest(signature) {
  const now = Date.now();

  for (const [key, timestamp] of recentPrintRequests.entries()) {
    if (now - timestamp > DUPLICATE_PRINT_WINDOW_MS) {
      recentPrintRequests.delete(key);
    }
  }

  return recentPrintRequests.has(signature);
}

function rememberPrintRequest(signature) {
  recentPrintRequests.set(signature, Date.now());
}

function fileExists(filePath) {
  try {
    return Boolean(filePath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function uniqueExistingStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function getPrintWorkerCandidates() {
  const executableName = path.basename(process.execPath || "Print Assistant.exe");
  const candidates = [
    process.execPath,
    app.getPath("exe"),
    process.argv[0],
    path.join(path.dirname(process.execPath || ""), executableName),
  ];

  if (process.resourcesPath) {
    candidates.push(path.join(path.dirname(process.resourcesPath), executableName));
  }

  if (!app.isPackaged) {
    candidates.push(process.execPath);
  }

  return uniqueExistingStrings(candidates);
}

function startIsolatedPrintJob(printPayload, context = {}) {
  printQueue = printQueue
    .catch(() => {
      // Keep the print queue alive after a failed job.
    })
    .then(() => runIsolatedPrintJob(printPayload));

  printQueue
    .then((result = {}) => {
      if (result.trace) {
        savePrintDiagnostic(result.trace);
      }
      localBridgeStats.lastPrint = {
        ...localBridgeStats.lastPrint,
        ...context,
        status: "success",
        finishedAt: new Date().toISOString(),
      };
      logPrint("info", "local_print_worker_success", context);
    })
    .catch((error) => {
      if (error.trace) {
        savePrintDiagnostic(error.trace);
      }
      localBridgeStats.lastPrint = {
        ...localBridgeStats.lastPrint,
        ...context,
        status: "failure",
        finishedAt: new Date().toISOString(),
        error: error.message || "PRINT_WORKER_FAILED",
      };
      localBridgeStats.lastError = {
        at: new Date().toISOString(),
        source: "print_worker",
        message: error.message || "PRINT_WORKER_FAILED",
      };
      logPrint("error", "local_print_worker_failure", {
        ...context,
        error,
      });
    });
}

function resolvePrintWorkerLaunch(jobPath) {
  const candidates = getPrintWorkerCandidates();
  const attempts = candidates.map((candidate) => ({
    path: candidate,
    exists: fileExists(candidate),
  }));
  const resolved = attempts.find((attempt) => attempt.exists);

  logLocalhost("info", "worker_resolved_executable_path", {
    jobPath,
    isPackaged: app.isPackaged,
    processExecPath: process.execPath,
    appExePath: app.getPath("exe"),
    resourcesPath: process.resourcesPath || "",
    resolvedPath: resolved?.path || "",
    exists: Boolean(resolved),
    attempts,
  });

  if (!resolved) {
    return {
      executablePath: "",
      args: [],
      attempts,
    };
  }

  return {
    executablePath: resolved.path,
    args: app.isPackaged
      ? [LOCAL_PRINT_WORKER_FLAG, jobPath]
      : [app.getAppPath(), LOCAL_PRINT_WORKER_FLAG, jobPath],
    attempts,
  };
}

function runIsolatedPrintJob(printPayload) {
  return new Promise((resolve, reject) => {
    const jobId = printPayload.job?.id || randomUUID();
    const jobsDirectory = getLocalPrintJobsDirectory();
    const jobPath = path.join(jobsDirectory, `${jobId}.json`);
    const resultPath = path.join(jobsDirectory, `${jobId}.result.json`);
    let settled = false;

    fs.writeFileSync(jobPath, JSON.stringify({ payload: printPayload, resultPath }), "utf8");

    const launch = resolvePrintWorkerLaunch(jobPath);

    if (!launch.executablePath) {
      logLocalhost("error", "worker_spawn_failed", {
        jobId,
        error: "WORKER_EXECUTABLE_NOT_FOUND",
        fallbackPathAttempted: launch.attempts,
      });
      runPrintJobInCurrentProcess(printPayload)
        .then((result) => {
          cleanupPrintJobFiles(jobPath, resultPath);
          resolve(result);
        })
        .catch((error) => {
          cleanupPrintJobFiles(jobPath, resultPath);
          reject(error);
        });
      return;
    }

    logLocalhost("info", "worker_spawning_process", {
      jobId,
      executablePath: launch.executablePath,
      args: launch.args,
    });

    const worker = spawn(launch.executablePath, launch.args, {
      cwd: app.getAppPath(),
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    });
    const stderrChunks = [];

    logLocalhost("info", "worker_pid", {
      jobId,
      pid: worker.pid || null,
    });

    worker.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrChunks.push(text);
      logLocalhost("error", "worker_stderr", {
        jobId,
        pid: worker.pid || null,
        stderr: text,
      });
    });

    worker.once("spawn", () => {
      logLocalhost("info", "worker_started", {
        jobId,
        pid: worker.pid || null,
      });
    });

    const timeoutMs = printPayload.silent === false ? PRINT_DIALOG_TIMEOUT_MS : PRINT_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      worker.kill();
      cleanupPrintJobFiles(jobPath, resultPath);
      logLocalhost("error", "worker_timeout", {
        jobId,
        pid: worker.pid || null,
        timeoutMs,
        executablePath: launch.executablePath,
      });
      const timeoutError = new Error("PRINT_TIMEOUT");
      if (printPayload.trace) {
        traceStep(printPayload.trace, "worker_timeout", false, {
          timeoutMs,
        });
        finishPrintTrace(printPayload.trace, "failure", { error: timeoutError });
        timeoutError.trace = printPayload.trace;
      }
      reject(timeoutError);
    }, timeoutMs);

    worker.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      cleanupPrintJobFiles(jobPath, resultPath);
      logLocalhost("error", "worker_spawn_failed", {
        jobId,
        executablePath: launch.executablePath,
        code: error.code || "",
        message: error.message || "WORKER_SPAWN_FAILED",
        isEnoent: error.code === "ENOENT" || /ENOENT/i.test(error.message || ""),
        fallbackPathAttempted: launch.attempts,
      });

      if (error.code === "ENOENT" || /ENOENT/i.test(error.message || "")) {
        runPrintJobInCurrentProcess(printPayload)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (printPayload.trace) {
        traceStep(printPayload.trace, "worker_spawn_error", false, { error });
        finishPrintTrace(printPayload.trace, "failure", { error });
        error.trace = printPayload.trace;
      }
      reject(error);
    });

    worker.on("exit", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      logLocalhost(code === 0 ? "info" : "error", "worker_exit_code", {
        jobId,
        pid: worker.pid || null,
        code,
        stderr: stderrChunks.join("").slice(-2000),
      });

      try {
        const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
        cleanupPrintJobFiles(jobPath, resultPath);

        if (code === 0 && result.success) {
          if (result.trace) {
            savePrintDiagnostic(result.trace);
          }
          resolve(result);
          return;
        }

        const workerError = new Error(result.error || `PRINT_WORKER_EXIT_${code}`);
        workerError.trace = result.trace || null;
        reject(workerError);
      } catch (error) {
        cleanupPrintJobFiles(jobPath, resultPath);
        reject(error);
      }
    });
  });
}

async function runPrintJobInCurrentProcess(printPayload) {
  const trace = printPayload.trace || createPrintTrace("local_print_in_process", {
    printer: printPayload.printerName || "",
  });

  logLocalhost("warn", "worker_fallback_in_process", {
    jobId: printPayload.job?.id || trace.jobId,
    printerName: printPayload.printerName || "",
  });
  traceStep(trace, "worker_fallback_in_process", true, {
    pid: process.pid,
    printerName: printPayload.printerName || "",
  });
  await printHtml(printPayload, trace);
  finishPrintTrace(trace, "success");
  return { success: true, trace };
}

function cleanupPrintJobFiles(...filePaths) {
  for (const filePath of filePaths) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best-effort cleanup for transient local print job files.
    }
  }
}

async function runLocalPrintWorker() {
  const flagIndex = process.argv.indexOf(LOCAL_PRINT_WORKER_FLAG);
  const jobPath = process.argv[flagIndex + 1];

  try {
    if (!jobPath) {
      throw new Error("PRINT_JOB_PATH_MISSING");
    }

    const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    const payload = job.payload || {};
    const trace = payload.trace || createPrintTrace("local_print_worker", {
      printer: payload.printerName || "",
    });
    traceStep(trace, "worker_started", true, {
      pid: process.pid,
      printerName: payload.printerName || "",
    });
    await printHtml(payload, trace);
    finishPrintTrace(trace, "success");
    fs.writeFileSync(job.resultPath, JSON.stringify({ success: true, trace }), "utf8");
    app.exit(0);
  } catch (error) {
    try {
      const job = jobPath && fs.existsSync(jobPath) ? JSON.parse(fs.readFileSync(jobPath, "utf8")) : {};
      const trace = job.payload?.trace || createPrintTrace("local_print_worker_error");
      traceStep(trace, "worker_error", false, { error });
      finishPrintTrace(trace, "failure", { error });
      if (job.resultPath) {
        fs.writeFileSync(job.resultPath, JSON.stringify({
          success: false,
          error: error.message || "PRINT_WORKER_FAILED",
          trace,
        }), "utf8");
      }
    } catch {
      // The parent process will translate a missing result into a controlled failure.
    }

    app.exit(1);
  }
}

function printWebContents(webContents, options, trace) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();
    const timeoutMs = options.silent ? PRINT_TIMEOUT_MS : PRINT_DIALOG_TIMEOUT_MS;
    traceStep(trace, "webcontents_print_started", true, {
      printerName: options.deviceName || "",
      silent: options.silent,
    });
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      const timeoutError = new Error("PRINT_TIMEOUT");
      traceStep(trace, "webcontents_print_timeout", false, {
        printerName: options.deviceName || "",
        durationMs: Date.now() - startedAt,
        timeoutMs,
      });
      reject(timeoutError);
    }, timeoutMs);

    webContents.print(options, (success, failureReason) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      const callback = {
        success: Boolean(success),
        failureReason: failureReason || "",
        printerName: options.deviceName || "",
        silent: options.silent,
        durationMs: Date.now() - startedAt,
      };
      if (trace) {
        trace.callback = callback;
        trace.callbacks = Array.isArray(trace.callbacks) ? trace.callbacks : [];
        trace.callbacks.push(callback);
      }
      traceStep(trace, "electron_callback_received", Boolean(success), callback);

      if (success) {
        resolve({ success: true, callback });
        return;
      }

      const printError = new Error(failureReason || "PRINT_FAILED");
      printError.callback = callback;
      reject(printError);
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

async function validatePrinterForWebContents(webContents, deviceName, trace) {
  traceStep(trace, "windows_printers_lookup_start", true, {
    deviceName,
  });
  const printers = await webContents.getPrintersAsync();
  const printerNames = printers.map((printer) => printer.name);
  const foundPrinter = printers.find((printer) => printer.name === deviceName);

  if (!foundPrinter) {
    traceStep(trace, "printer_not_found", false, {
      deviceName,
      foundPrinters: printerNames,
    });
    throw new Error("PRINTER_NOT_FOUND");
  }

  traceStep(trace, "printer_found", true, {
    deviceName,
    printerName: foundPrinter.name,
    isDefault: Boolean(foundPrinter.isDefault),
    status: foundPrinter.status ?? null,
  });
  return foundPrinter;
}

function checkWindowsSpooler(trace) {
  if (process.platform !== "win32") {
    traceStep(trace, "spooler_status", true, {
      platform: process.platform,
      status: "not_applicable",
    });
    return Promise.resolve("not_applicable");
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    execFile("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "(Get-Service -Name Spooler).Status.ToString()",
    ], {
      timeout: 5000,
      windowsHide: true,
    }, (error, stdout) => {
      const status = String(stdout || "").trim();

      if (error) {
        traceStep(trace, "spooler_status", false, {
          durationMs: Date.now() - startedAt,
          error,
        });
        reject(new Error("SPOOLER_STATUS_FAILED"));
        return;
      }

      traceStep(trace, "spooler_status", status === "Running", {
        status,
        durationMs: Date.now() - startedAt,
      });

      if (status !== "Running") {
        reject(new Error("SPOOLER_NOT_RUNNING"));
        return;
      }

      resolve(status);
    });
  });
}

function isThermalPrintPayload(payload = {}) {
  return payload.type === "thermal" || ["58mm", "80mm"].includes(payload.paperSize);
}

function buildElectronPrintOptions(payload = {}, silent = false) {
  const options = {
    silent,
    deviceName: payload.printerName,
    copies: Math.max(1, Number(payload.copies || 1)),
  };

  if (!isThermalPrintPayload(payload)) {
    options.printBackground = true;
    options.margins = { marginType: "none" };
  }

  return options;
}

async function printHtml(payload, trace = null) {
  const printContext = getPrintPayloadSummary(payload, "html");
  logPrint("info", "html_print_start", printContext);
  const html = buildPrintDocument(payload);
  const isThermal = isThermalPrintPayload(payload);
  const startsWithDialog = payload.silent === false;
  const attempts = startsWithDialog ? [false] : [true, false];

  traceStep(trace, "print_strategy_selected", true, {
    isThermal,
    startsWithDialog,
    attempts: attempts.map((silent) => silent ? "silent" : "dialog"),
  });

  await checkWindowsSpooler(trace);

  for (const silent of attempts) {
    traceStep(trace, "browser_window_create_start", true, {
      ...printContext,
      silent,
    });
    const printWindow = createPrintWindow();

    try {
    traceStep(trace, "browser_window_created", true, {
      width: 900,
      height: 700,
      show: false,
      silent,
    });
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    traceStep(trace, "html_loaded", true, {
      htmlLength: html.length,
      silent,
    });

    await validatePrinterForWebContents(printWindow.webContents, payload.printerName, trace);

      await printWebContents(printWindow.webContents, buildElectronPrintOptions(payload, silent), trace);

      traceStep(trace, "print_attempt_success", true, {
        silent,
        fallbackUsed: !silent && !startsWithDialog,
      });
      logPrint("info", "html_print_success", {
        ...printContext,
        silent,
        fallbackUsed: !silent && !startsWithDialog,
      });
      return { success: true, fallbackUsed: !silent && !startsWithDialog };
    } catch (error) {
      traceStep(trace, silent ? "silent_print_failed_trying_dialog" : "dialog_print_failed", false, {
        failureReason: error.message,
        callback: error.callback || null,
      });

      if (!silent) {
        traceStep(trace, "html_print_failure", false, { error });
        logPrint("error", "html_print_failure", { ...printContext, error });
        throw error;
      }
    } finally {
      if (!printWindow.isDestroyed()) {
        printWindow.destroy();
      }
    }
  }

  throw new Error("PRINT_FAILED");
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

async function printRawTestPayload(payload = {}) {
  const settings = readLocalSettings();
  const requestedSector = normalizeSectorName(payload.setor || payload.sector || "");
  const sectorAssignment = requestedSector
    ? resolveSectorAssignment(cachedPrinters.length ? cachedPrinters : await getPrinters(), requestedSector, settings)
    : null;
  const requestedPrinter = payload.printer
    || payload.printerName
    || sectorAssignment?.printer?.name
    || settings.preferredPrinter
    || "";
  const trace = createPrintTrace("raw_print_test", {
    requestedPrinter,
  });

  try {
    traceStep(trace, "json_validated", true, {
      requestedPrinter,
    });
    const { printer, resolvedBy } = await resolveLocalPrinter(requestedPrinter);

    if (!printer) {
      traceStep(trace, "printer_not_found", false, {
        requestedPrinter,
        foundPrinters: cachedPrinters.map((cachedPrinter) => cachedPrinter.name),
      });
      finishPrintTrace(trace, "failure", { message: "PRINTER_NOT_FOUND" });
      throw createHttpError(404, "PRINTER_NOT_FOUND");
    }

    trace.printer = printer.name;
    traceStep(trace, "printer_found", true, {
      requestedPrinter,
      printerName: printer.name,
      resolvedBy,
    });

    const printWindow = new BrowserWindow({
      width: 300,
      height: 600,
      show: false,
    });

    printWindows.add(printWindow);
    attachWindowDiagnostics(printWindow, "raw-test");
    traceStep(trace, "browser_window_created", true, {
      width: 300,
      height: 600,
      show: false,
    });

    try {
      const html = "<!doctype html><html><body>TESTE PRINT ASSISTANT<br>LOCAL-FIRST<br>OK</body></html>";
      await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      traceStep(trace, "html_loaded", true, {
        htmlLength: html.length,
      });
      await checkWindowsSpooler(trace);
      await validatePrinterForWebContents(printWindow.webContents, printer.name, trace);
      await printWebContents(printWindow.webContents, {
        silent: false,
        deviceName: printer.name,
      }, trace);
      finishPrintTrace(trace, "success");
      return {
        success: true,
        jobId: trace.jobId,
        printer: printer.name,
        resolvedBy,
        trace,
      };
    } finally {
      if (!printWindow.isDestroyed()) {
        printWindow.close();
      }
      printWindows.delete(printWindow);
      traceStep(trace, "browser_window_closed", true);
    }
  } catch (error) {
    traceStep(trace, "raw_print_test_failure", false, { error });
    finishPrintTrace(trace, "failure", { error });
    throw error;
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

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function writeJsonResponse(response, statusCode, body) {
  response.writeHead(statusCode, {
    ...getCorsHeaders(),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let rejected = false;

    request.on("data", (chunk) => {
      if (rejected) {
        return;
      }

      body += chunk.toString("utf8");

      if (Buffer.byteLength(body, "utf8") > LOCAL_REQUEST_MAX_BYTES) {
        rejected = true;
        reject(createHttpError(413, "PAYLOAD_TOO_LARGE"));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(createHttpError(400, "INVALID_JSON"));
      }
    });

    request.on("error", reject);
  });
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isLocalRequest(request) {
  const address = request.socket?.remoteAddress || "";
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

function recordLocalRequest(request, route, statusCode) {
  localBridgeStats.requestCount += 1;
  localBridgeStats.lastRequest = {
    at: new Date().toISOString(),
    method: request.method,
    route,
    statusCode,
    origin: request.headers.origin || "",
  };
}

function logHttpRequest(request, route, statusCode, startedAt) {
  const durationMs = Math.max(0, Date.now() - startedAt);
  const details = {
    method: request.method,
    route,
    origin: request.headers.origin || "",
    statusCode,
    durationMs,
  };

  logLocalhost("info", "http_request", details);
  logLocalhost("info", "http_line", {
    line: `[HTTP] ${request.method} ${route} ${statusCode} ${durationMs}ms`,
  });
}

function buildPrintersResponse(printers = []) {
  return printers.map((printer) => ({
    name: printer.name,
    isDefault: Boolean(printer.isDefault),
  }));
}

async function getLocalBridgeStatus() {
  const printers = await getPrinters();
  const defaultPrinter = getDefaultPrinter(printers);
  const settings = readLocalSettings();
  const sectors = buildSectorSnapshot(printers, settings);

  return {
    online: Boolean(localBridgeListening),
    version: app.getVersion(),
    listening: localBridgeListening,
    defaultPrinter: defaultPrinter?.name || null,
    printers,
    sectors,
    diagnostics: {
      ...localBridgeStats,
      lastPrintDiagnostic,
      update: updateStatus,
    },
  };
}

async function getLocalBridgeHealth() {
  const printers = await getPrinters();

  return {
    ok: localBridgeListening,
    listening: localBridgeListening,
    version: app.getVersion(),
    printerCount: printers.length,
    queueBusy: printWindows.size > 0,
    lastHealthCheckAt: localBridgeStats.lastHealthCheckAt,
  };
}

async function handleLocalBridgeRequest(request, response) {
  const startedAt = Date.now();
  const url = new URL(request.url, `http://localhost:${LOCAL_BRIDGE_PORT}`);
  const route = url.pathname;

  if (!isLocalRequest(request)) {
    recordLocalRequest(request, route, 403);
    logHttpRequest(request, route, 403, startedAt);
    writeJsonResponse(response, 403, {
      success: false,
      error: "LOCALHOST_ONLY",
    });
    return;
  }

  if (request.method === "OPTIONS") {
    recordLocalRequest(request, route, 204);
    logHttpRequest(request, route, 204, startedAt);
    writeJsonResponse(response, 204, {});
    return;
  }

  try {
    if (request.method === "GET" && route === "/status") {
      recordLocalRequest(request, route, 200);
      logHttpRequest(request, route, 200, startedAt);
      writeJsonResponse(response, 200, await getLocalBridgeStatus());
      return;
    }

    if (request.method === "GET" && route === "/health") {
      recordLocalRequest(request, route, 200);
      logHttpRequest(request, route, 200, startedAt);
      writeJsonResponse(response, 200, await getLocalBridgeHealth());
      return;
    }

    if (request.method === "GET" && route === "/printers") {
      const printers = await getPrinters();
      recordLocalRequest(request, route, 200);
      logHttpRequest(request, route, 200, startedAt);
      writeJsonResponse(response, 200, buildPrintersResponse(printers));
      return;
    }

    if (request.method === "POST" && route === "/print") {
      const payload = await readRequestJson(request);
      const result = await printLocalPayload(payload);
      recordLocalRequest(request, route, 200);
      logHttpRequest(request, route, 200, startedAt);
      writeJsonResponse(response, 200, result);
      return;
    }

    if (request.method === "POST" && route === "/print-test") {
      const payload = await readRequestJson(request);
      const result = await printRawTestPayload(payload);
      recordLocalRequest(request, route, 200);
      logHttpRequest(request, route, 200, startedAt);
      writeJsonResponse(response, 200, result);
      return;
    }

    recordLocalRequest(request, route, 404);
    logHttpRequest(request, route, 404, startedAt);
    writeJsonResponse(response, 404, {
      success: false,
      error: "NOT_FOUND",
    });
  } catch (error) {
    logPrint("error", "local_bridge_request_failed", {
      method: request.method,
      path: route,
      error,
    });
    localBridgeStats.lastError = {
      at: new Date().toISOString(),
      source: "http",
      message: error.message || "LOCAL_BRIDGE_ERROR",
    };
    const statusCode = error.statusCode || 500;
    recordLocalRequest(request, route, statusCode);
    logHttpRequest(request, route, statusCode, startedAt);
    writeJsonResponse(response, statusCode, {
      success: false,
      error: error.message || "LOCAL_BRIDGE_ERROR",
    });
  }
}

function startLocalBridgeServer() {
  if (localBridgeServer) {
    return;
  }

  localBridgeServer = http.createServer((request, response) => {
    handleLocalBridgeRequest(request, response);
  });

  localBridgeServer.on("error", (error) => {
    localBridgeListening = false;
    logError("local_bridge_server_error", { error, port: LOCAL_BRIDGE_PORT });
  });

  localBridgeServer.listen(LOCAL_BRIDGE_PORT, LOCAL_BRIDGE_HOST, () => {
    localBridgeListening = true;
    logLocalhost("info", "server_started", {
      host: LOCAL_BRIDGE_HOST,
      port: LOCAL_BRIDGE_PORT,
    });
    getPrinters().catch((error) => {
      logPrint("warn", "local_bridge_printer_cache_warm_failed", { error });
    });
  });
}

function stopLocalBridgeServer() {
  if (!localBridgeServer) {
    localBridgeListening = false;
    return;
  }

  const server = localBridgeServer;
  localBridgeServer = null;
  localBridgeListening = false;

  try {
    server.close((error) => {
      if (error) {
        logError("local_bridge_server_stop_failed", { error });
        return;
      }

      logLocalhost("info", "server_stopped");
    });
    server.closeAllConnections?.();
  } catch (error) {
    logError("local_bridge_server_stop_exception", { error });
  }
}

function startWatchdog() {
  stopWatchdog();
  watchdogTimer = setInterval(() => {
    runHealthCheck().catch((error) => {
      logError("watchdog_health_check_failed", { error });
    });
  }, WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref?.();
}

function stopWatchdog() {
  if (!watchdogTimer) {
    return;
  }

  clearInterval(watchdogTimer);
  watchdogTimer = null;
}

async function runHealthCheck() {
  if (isQuitting) {
    return;
  }

  localBridgeStats.healthChecks += 1;
  localBridgeStats.lastHealthCheckAt = new Date().toISOString();

  if (!mainWindow || mainWindow.isDestroyed()) {
    logApp("warn", "watchdog_recreating_window");
    createWindow({ show: false });
  }

  if (!localBridgeServer || !localBridgeListening) {
    logLocalhost("warn", "watchdog_restarting_localhost", {
      listening: localBridgeListening,
      hasServer: Boolean(localBridgeServer),
    });
    stopLocalBridgeServer();
    startLocalBridgeServer();
    return;
  }

  try {
    await getPrinters();
  } catch (error) {
    localBridgeStats.lastError = {
      at: new Date().toISOString(),
      source: "healthcheck",
      message: error.message || "HEALTHCHECK_FAILED",
    };
    logError("healthcheck_printer_refresh_failed", { error });
  }
}

function cleanupBeforeQuit() {
  if (shutdownCleanupDone) {
    return;
  }

  shutdownCleanupDone = true;
  logApp("info", "app_shutdown_started", {
    activePrintWindows: printWindows.size,
  });
  isQuitting = true;
  stopWatchdog();
  stopLocalBridgeServer();

  for (const printWindow of printWindows) {
    if (!printWindow.isDestroyed()) {
      printWindow.destroy();
    }
  }

  printWindows.clear();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
    mainWindow = null;
  }

  if (tray) {
    tray.destroy();
    tray = null;
  }

  logApp("info", "app_shutdown_cleanup_complete");
}

function getDefaultUpdateStatus() {
  return {
    prepared: true,
    enabled: true,
    checking: false,
    available: false,
    downloaded: false,
    version: "",
    error: "",
    lastCheckedAt: "",
  };
}

function configureAutoUpdate() {
  autoUpdater.logger = appLogger;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => {
    updateStatus = {
      ...updateStatus,
      checking: true,
      error: "",
      lastCheckedAt: new Date().toISOString(),
    };
    logUpdater("info", "auto_update_checking");
  });

  autoUpdater.on("update-available", (info) => {
    updateStatus = {
      ...updateStatus,
      checking: false,
      available: true,
      version: info?.version || "",
    };
    logUpdater("info", "auto_update_available", { version: info?.version || "" });

    autoUpdater.downloadUpdate().catch((error) => {
      updateStatus = {
        ...updateStatus,
        error: error.message || "AUTO_UPDATE_DOWNLOAD_FAILED",
      };
      logUpdater("error", "auto_update_download_failed", { error });
    });
  });

  autoUpdater.on("update-not-available", () => {
    updateStatus = {
      ...updateStatus,
      checking: false,
      available: false,
      downloaded: false,
    };
    logUpdater("info", "auto_update_not_available");
  });

  autoUpdater.on("update-downloaded", (info) => {
    updateStatus = {
      ...updateStatus,
      checking: false,
      available: true,
      downloaded: true,
      version: info?.version || updateStatus.version,
    };
    logUpdater("info", "auto_update_downloaded", { version: info?.version || "" });

    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Atualizacao disponivel",
      message: "Uma nova versao do Print Assistant foi baixada.",
      detail: "A instalacao so acontece se voce confirmar. O app nao sera reiniciado automaticamente.",
      buttons: ["Instalar ao sair", "Depois"],
      defaultId: 1,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        logUpdater("info", "auto_update_install_on_quit_selected");
        autoUpdater.autoInstallOnAppQuit = true;
      }
    }).catch((error) => {
      logUpdater("error", "auto_update_prompt_failed", { error });
    });
  });

  autoUpdater.on("error", (error) => {
    updateStatus = {
      ...updateStatus,
      checking: false,
      error: error.message || "AUTO_UPDATE_ERROR",
    };
    logUpdater("error", "auto_update_error", { error });
  });
}

function maybeCheckForUpdates() {
  updateStatus = {
    ...updateStatus,
    enabled: true,
  };

  if (!app.isPackaged || !updateStatus.enabled) {
    logUpdater("info", "auto_update_check_skipped", {
      isPackaged: app.isPackaged,
      enabled: updateStatus.enabled,
    });
    return;
  }

  autoUpdater.checkForUpdates().catch((error) => {
    updateStatus = {
      ...updateStatus,
      checking: false,
      error: error.message || "AUTO_UPDATE_CHECK_FAILED",
    };
    logUpdater("error", "auto_update_check_failed", { error });
  });
}

async function checkForUpdatesFromRenderer() {
  updateStatus = {
    ...updateStatus,
    enabled: true,
    checking: true,
    error: "",
    lastCheckedAt: new Date().toISOString(),
  };

  if (!app.isPackaged) {
    updateStatus = {
      ...updateStatus,
      checking: false,
      available: false,
      downloaded: false,
    };
    logUpdater("info", "auto_update_renderer_check_skipped_dev");
    return updateStatus;
  }

  try {
    await autoUpdater.checkForUpdates();
    return updateStatus;
  } catch (error) {
    updateStatus = {
      ...updateStatus,
      checking: false,
      error: error.message || "AUTO_UPDATE_CHECK_FAILED",
    };
    logUpdater("error", "auto_update_renderer_check_failed", { error });
    return updateStatus;
  }
}

function installDownloadedUpdate() {
  if (!updateStatus.downloaded) {
    throw new Error("UPDATE_NOT_DOWNLOADED");
  }

  logUpdater("info", "auto_update_install_requested");
  autoUpdater.quitAndInstall(false, true);
  return { success: true };
}

ipcMain.handle("print-agent:get-status", getLocalBridgeStatus);
ipcMain.handle("print-agent:print-test", (_event, payload) => printRawTestPayload(payload || {}));
ipcMain.handle("print-agent:check-for-updates", checkForUpdatesFromRenderer);
ipcMain.handle("print-agent:install-update", installDownloadedUpdate);
ipcMain.handle("print-agent:quit", () => {
  requestAppQuit("renderer");
  return { success: true };
});

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    if (isLocalPrintWorker) {
      return runLocalPrintWorker();
    }

    logApp("info", "app_ready", getAppStatus());
    configureAutoUpdate();
    configureAutoStart();
    createTray();
    createWindow({ show: startupMode !== "hidden" });
    startLocalBridgeServer();
    startWatchdog();
    maybeCheckForUpdates();
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
}
