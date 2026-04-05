import fs from "fs";
import path from "path";
import { app } from "electron";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_ROTATED_FILES = 5;

let logsDir: string | null = null;
let logFilePath: string | null = null;
let logStream: fs.WriteStream | null = null;
let minLevel: LogLevel = "info";
let bytesWritten = 0;

function ensureLogsDir(): string {
  if (!logsDir) {
    logsDir = path.join(app.getPath("userData"), "logs");
  }
  fs.mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

function getLogFilePath(): string {
  if (!logFilePath) {
    logFilePath = path.join(ensureLogsDir(), "munajjam.log");
  }
  return logFilePath;
}

function rotate() {
  if (!logStream) return;
  logStream.end();
  logStream = null;
  bytesWritten = 0;

  const filePath = getLogFilePath();
  const dir = ensureLogsDir();

  // Shift existing rotated files: .4 -> .5, .3 -> .4, etc.
  for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
    const older = path.join(dir, `munajjam.log.${i}`);
    const newer = i === 1 ? filePath : path.join(dir, `munajjam.log.${i - 1}`);
    try {
      if (i === MAX_ROTATED_FILES && fs.existsSync(older)) {
        fs.unlinkSync(older);
      }
      if (fs.existsSync(newer)) {
        fs.renameSync(newer, older);
      }
    } catch {
      // Best-effort rotation — don't block logging
    }
  }
}

function getStream(): fs.WriteStream {
  if (!logStream) {
    const filePath = getLogFilePath();
    // Check existing file size for rotation on startup
    try {
      const stat = fs.statSync(filePath);
      bytesWritten = stat.size;
      if (bytesWritten >= MAX_LOG_FILE_BYTES) {
        rotate();
      }
    } catch {
      bytesWritten = 0;
    }

    logStream = fs.createWriteStream(filePath, { flags: "a" });
  }
  return logStream;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, category: string, message: string, data?: unknown): string {
  const parts = [
    `[${formatTimestamp()}]`,
    `[${level.toUpperCase().padEnd(5)}]`,
    `[${category}]`,
    message,
  ];

  if (data !== undefined) {
    try {
      parts.push(JSON.stringify(data));
    } catch {
      parts.push("[unserializable data]");
    }
  }

  return parts.join(" ") + "\n";
}

function write(level: LogLevel, category: string, message: string, data?: unknown) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const line = formatMessage(level, category, message, data);

  // Always write to console for dev visibility
  const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleFn(`[${category}] ${message}`, data !== undefined ? data : "");

  try {
    if (bytesWritten >= MAX_LOG_FILE_BYTES) {
      rotate();
    }
    const stream = getStream();
    stream.write(line);
    bytesWritten += Buffer.byteLength(line, "utf-8");
  } catch {
    // Don't crash the app if logging fails
  }
}

/**
 * Create a scoped logger for a specific module/category.
 *
 * Usage:
 *   const log = createLogger("python-check");
 *   log.info("Checking environment...");
 *   log.error("Failed to find Python", { error: err.message });
 */
export function createLogger(category: string) {
  return {
    debug: (message: string, data?: unknown) => write("debug", category, message, data),
    info: (message: string, data?: unknown) => write("info", category, message, data),
    warn: (message: string, data?: unknown) => write("warn", category, message, data),
    error: (message: string, data?: unknown) => write("error", category, message, data),
  };
}

/**
 * Set the minimum log level. Messages below this level are discarded.
 */
export function setLogLevel(level: LogLevel) {
  minLevel = level;
}

/**
 * Returns the path to the logs directory.
 */
export function getLogsPath(): string {
  return ensureLogsDir();
}

/**
 * Flush and close the log stream. Call on app quit.
 */
export function closeLogger() {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}
