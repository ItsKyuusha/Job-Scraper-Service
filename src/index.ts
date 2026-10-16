import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { scrapeRouter } from "./routes/scrape.route.js";
import { queueRouter } from "./routes/queue.route.js";
import { rateLimiter, errorHandler, notFound } from "./middleware/index.js";
import { logger } from "./utils/logger.js";

const app = express();

// ─── Core Middleware ──────────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : "*",
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(morgan("dev"));
app.use(rateLimiter);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    service: "CareerSync Job Scraper Service",
    version: "1.0.0",
    status: "running",
    uptime_s: Math.floor(process.uptime()),
    docs: {
      "GET /api/scrape":
        "Scrape all sources. Params: keyword, location, sources, page, limit",
      "GET /api/scrape/portals":
        "Scrape formal job portals only (JobStreet, Glints)",
      "GET /api/scrape/social":
        "Scrape social media & community feeds only (Threads, LinkedIn)",
      "GET /api/scrape/category/:cat":
        "Scrape by category (portals | social)",
      "GET /api/scrape/:source":
        "Scrape specific source (linkedin | jobstreet | glints | threads)",
      "POST /api/scrape/queue":
        "Async scrape, returns job_id. Body: { keyword, location, sources, limit }",
      "GET /api/queue":        "List all queued/completed jobs",
      "GET /api/queue/:id":    "Get job status and results",
      "DELETE /api/queue/:id": "Remove a completed job",
    },
    categories: {
      portals: ["jobstreet", "glints"],
      social: ["threads", "linkedin"],
    },
    sources: ["linkedin", "jobstreet", "glints", "threads"],
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime_s: Math.floor(process.uptime()) });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use("/api/scrape", scrapeRouter);
app.use("/api/queue", queueRouter);

// ─── Error Handling ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Start Server (local/Railway/Render only — Vercel uses exported app) ──────
if (process.env.VERCEL !== "1") {
  const PORT = Number(process.env.PORT ?? 3001);
  const server = app.listen(PORT, () => {
    logger.info(`[Server] CareerSync Scraper Service running on http://localhost:${PORT}`);
    logger.info(`[Server] Sources: linkedin, jobstreet, glints, threads`);
    logger.info(`[Server] Environment: ${process.env.NODE_ENV ?? "development"}`);
  });

  async function shutdown(signal: string): Promise<void> {
    logger.info(`[Server] Received ${signal}, shutting down gracefully...`);
    const { closeBrowser } = await import("./utils/browser.js");
    server.close(async () => {
      await closeBrowser();
      logger.info("[Server] Server closed. Bye!");
      process.exit(0);
    });
    setTimeout(() => {
      logger.error("[Server] Forced shutdown after timeout");
      process.exit(1);
    }, 10_000);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    logger.error("[Server] Uncaught exception", { error: err.message, stack: err.stack });
    shutdown("uncaughtException");
  });
}

export default app;

