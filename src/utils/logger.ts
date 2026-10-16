import { createLogger, format, transports } from "winston";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const isVercel = process.env.VERCEL === "1";
const isProduction = process.env.NODE_ENV === "production";

// ─── Transport list ───────────────────────────────────────────────────────────
// Vercel filesystem is read-only — only Console transport is safe there.
// Local / Railway / Render: also write to log files.
const loggerTransports: (
  | transports.ConsoleTransportInstance
  | transports.FileTransportInstance
)[] = [
  new transports.Console({
    format: format.combine(
      isProduction ? format.uncolorize() : format.colorize(),
      format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
        return `[${timestamp}] ${level}: ${message}${metaStr}`;
      })
    ),
  }),
];

if (!isVercel) {
  try {
    const logsDir = join(process.cwd(), "logs");
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    loggerTransports.push(
      new transports.File({
        filename: join(logsDir, "error.log"),
        level: "error",
        maxsize: 5 * 1024 * 1024, // 5 MB
        maxFiles: 3,
      }),
      new transports.File({
        filename: join(logsDir, "combined.log"),
        maxsize: 10 * 1024 * 1024, // 10 MB
        maxFiles: 5,
      })
    );
  } catch {
    // If fs operations fail, continue with console-only logging
  }
}

export const logger = createLogger({
  level: isProduction ? "info" : "debug",
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: loggerTransports,
});
