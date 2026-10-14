import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";

interface RateLimitStore {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitStore>();

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000); // 1 minute
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX ?? 30);

/**
 * Simple in-memory rate limiter.
 * Resets the count every WINDOW_MS milliseconds per IP.
 */
export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();

  let entry = store.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    store.set(ip, entry);
  }

  entry.count++;

  res.setHeader("X-RateLimit-Limit", MAX_REQUESTS);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, MAX_REQUESTS - entry.count));
  res.setHeader("X-RateLimit-Reset", Math.ceil(entry.resetAt / 1000));

  if (entry.count > MAX_REQUESTS) {
    logger.warn("[RateLimit] Limit exceeded", { ip, count: entry.count });
    res.status(429).json({
      success: false,
      error: "Terlalu banyak request. Coba lagi dalam 1 menit.",
      retry_after_ms: entry.resetAt - now,
    });
    return;
  }

  next();
}

/**
 * Global error handler middleware.
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error("[Error] Unhandled error", {
    method: req.method,
    url: req.url,
    error: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    success: false,
    error: "Internal server error",
    detail: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
}

/**
 * 404 handler for unknown routes.
 */
export function notFound(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: `Route '${req.method} ${req.url}' tidak ditemukan.`,
  });
}
