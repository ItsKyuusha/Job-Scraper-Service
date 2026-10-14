import pLimit from "p-limit";
import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { scraperRegistry } from "../scrapers/registry.js";
import { scrapeQueue } from "../queue/scrape-queue.js";
import { normalizeKeyword } from "../utils/helpers.js";
import {
  type ScrapeQuery,
  type ScraperSource,
  type ScraperCategory,
  type ScrapeSuccessResponse,
  type ScrapeErrorResponse,
  CATEGORY_SOURCES,
} from "../types/index.js";
import { logger } from "../utils/logger.js";

export const scrapeRouter = Router();

// Limit concurrent browser tabs to avoid RAM starvation and timeouts on single machine
const scrapeConcurrency = pLimit(1);

// ─── Validation helper ────────────────────────────────────────────────────────

function parseQuery(req: Request): { query: ScrapeQuery; sources: ScraperSource[] } {
  const rawKeyword = String(req.query["keyword"] ?? "").trim();
  const keyword = normalizeKeyword(rawKeyword);
  const location = String(req.query["location"] ?? "Indonesia").trim();
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1"), 10));
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query["limit"] ?? "20"), 10)));
  const rawSources = String(req.query["sources"] ?? "all").split(",").map((s) => s.trim());

  const validSources: ScraperSource[] = ["linkedin", "jobstreet", "glints", "threads"];
  const sources: ScraperSource[] =
    rawSources.includes("all")
      ? validSources
      : rawSources.filter((s): s is ScraperSource => validSources.includes(s as ScraperSource));

  return { query: { keyword, location, page, limit }, sources };
}

// ─── GET /api/scrape ──────────────────────────────────────────────────────────
/**
 * Synchronous multi-source scrape with sequential execution to preserve browser resources.
 */
scrapeRouter.get("/", async (req: Request, res: Response) => {
  const { query, sources } = parseQuery(req);

  if (!query.keyword) {
    res.status(400).json({ success: false, error: "Parameter 'keyword' wajib diisi." });
    return;
  }

  const startTime = Date.now();
  logger.info("[API] Scrape request received", { query, sources });

  const allResults: ScrapeSuccessResponse["results"] = [];
  const errors: string[] = [];

  // Run scraper sources sequentially to prevent browser context overload and CPU spikes
  for (const source of sources) {
    const scraper = scraperRegistry[source];
    if (!scraper) continue;

    try {
      logger.info(`[API] Executing scraper for ${source}...`);
      const results = await scraper.scrape(query);
      allResults.push(...results);
      logger.info(`[API] Finished ${source}: ${results.length} results`);
    } catch (err) {
      const msg = `${source}: ${String(err)}`;
      errors.push(msg);
      logger.error("[API] Scraper failed", { source, error: String(err) });
    }
  }

  const duration = Date.now() - startTime;

  if (allResults.length === 0 && errors.length > 0) {
    const errRes: ScrapeErrorResponse = {
      success: false,
      source: sources.length === 1 ? sources[0] : "multi",
      error: "Semua sumber gagal di-scrape.",
      detail: errors.join(" | "),
    };
    res.status(502).json(errRes);
    return;
  }

  const successRes: ScrapeSuccessResponse = {
    success: true,
    source: sources.length === 1 ? sources[0] : "multi",
    query,
    total: allResults.length,
    results: allResults,
    scraped_at: new Date().toISOString(),
    duration_ms: duration,
  };

  res.json(successRes);
});

// ─── Helper for category scraping ─────────────────────────────────────────────
async function handleCategoryScrape(
  category: ScraperCategory,
  req: Request,
  res: Response
) {
  const { query, sources: requestedSources } = parseQuery(req);

  if (!query.keyword) {
    res.status(400).json({ success: false, error: "Parameter 'keyword' wajib diisi." });
    return;
  }

  // Filter sources only belonging to this category
  const allowedSources = CATEGORY_SOURCES[category];
  const activeSources = requestedSources.filter((s) => allowedSources.includes(s));
  const finalSources = activeSources.length > 0 ? activeSources : allowedSources;

  const startTime = Date.now();
  logger.info(`[API] Category scrape (${category})`, { query, sources: finalSources });

  const allResults: ScrapeSuccessResponse["results"] = [];
  const errors: string[] = [];

  for (const source of finalSources) {
    const scraper = scraperRegistry[source];
    if (!scraper) continue;

    try {
      logger.info(`[API] Executing ${source} for category ${category}...`);
      const results = await scraper.scrape(query);
      allResults.push(...results);
      logger.info(`[API] Finished ${source}: ${results.length} results`);
    } catch (err) {
      const msg = `${source}: ${String(err)}`;
      errors.push(msg);
      logger.error(`[API] Scraper failed (${source})`, { error: String(err) });
    }
  }

  const duration = Date.now() - startTime;

  if (allResults.length === 0 && errors.length > 0) {
    const errRes: ScrapeErrorResponse = {
      success: false,
      source: "multi",
      error: `Semua sumber ${category} gagal di-scrape.`,
      detail: errors.join(" | "),
    };
    res.status(502).json(errRes);
    return;
  }

  const successRes: ScrapeSuccessResponse = {
    success: true,
    source: "multi",
    query,
    total: allResults.length,
    results: allResults,
    scraped_at: new Date().toISOString(),
    duration_ms: duration,
  };

  res.json(successRes);
}

// ─── GET /api/scrape/portals ──────────────────────────────────────────────────
/**
 * Scrape formal job boards only (JobStreet, Glints).
 */
scrapeRouter.get("/portals", async (req: Request, res: Response) => {
  await handleCategoryScrape("portals", req, res);
});

// ─── GET /api/scrape/social ───────────────────────────────────────────────────
/**
 * Scrape social media & community feeds only (Threads, LinkedIn).
 */
scrapeRouter.get("/social", async (req: Request, res: Response) => {
  await handleCategoryScrape("social", req, res);
});

// ─── GET /api/scrape/category/:category ───────────────────────────────────────
/**
 * Dynamic category scrape.
 * Param :category: "portals" | "social"
 */
scrapeRouter.get("/category/:category", async (req: Request, res: Response) => {
  const category = req.params["category"] as ScraperCategory;
  if (!["portals", "social"].includes(category)) {
    res.status(404).json({
      success: false,
      error: `Kategori '${category}' tidak dikenali. Pilihan: portals, social`,
    });
    return;
  }
  await handleCategoryScrape(category, req, res);
});

// ─── GET /api/scrape/:source ──────────────────────────────────────────────────
/**
 * Scrape a specific source directly.
 * Path: /api/scrape/linkedin | /api/scrape/jobstreet | /api/scrape/glints | /api/scrape/threads
 */
scrapeRouter.get("/:source", async (req: Request, res: Response) => {
  const source = req.params["source"] as ScraperSource;
  const { query } = parseQuery(req);

  const validSources: ScraperSource[] = ["linkedin", "jobstreet", "glints", "threads"];
  if (!validSources.includes(source)) {
    res.status(404).json({
      success: false,
      error: `Sumber '${source}' tidak dikenali. Pilihan: ${validSources.join(", ")}`,
    });
    return;
  }

  if (!query.keyword) {
    res.status(400).json({ success: false, error: "Parameter 'keyword' wajib diisi." });
    return;
  }

  const scraper = scraperRegistry[source];
  const startTime = Date.now();

  logger.info("[API] Single-source scrape", { source, query });

  try {
    const results = await scraper.scrape(query);
    const successRes: ScrapeSuccessResponse = {
      success: true,
      source,
      query,
      total: results.length,
      results,
      scraped_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    };
    res.json(successRes);
  } catch (err) {
    logger.error("[API] Scrape error", { source, error: String(err) });
    const errRes: ScrapeErrorResponse = {
      success: false,
      source,
      error: "Gagal scraping dari sumber ini.",
      detail: String(err),
    };
    res.status(502).json(errRes);
  }
});

// ─── POST /api/scrape/queue ───────────────────────────────────────────────────
/**
 * Async queue-based scrape. Returns a job ID immediately.
 * Check status via GET /api/queue/:id
 */
scrapeRouter.post("/queue", async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const rawKeyword = String(body["keyword"] ?? "").trim();
  const keyword = normalizeKeyword(rawKeyword);
  const location = String(body["location"] ?? "Indonesia").trim();
  const page = parseInt(String(body["page"] ?? "1"), 10);
  const limit = Math.min(50, parseInt(String(body["limit"] ?? "20"), 10));
  const rawSources = (body["sources"] as string[] | undefined) ?? ["all"];

  if (!keyword) {
    res.status(400).json({ success: false, error: "Parameter 'keyword' wajib diisi." });
    return;
  }

  const validSources: ScraperSource[] = ["linkedin", "jobstreet", "glints", "threads"];
  const sources: ScraperSource[] =
    rawSources.includes("all")
      ? validSources
      : rawSources.filter((s): s is ScraperSource => validSources.includes(s as ScraperSource));

  const jobId = uuidv4();
  const query: ScrapeQuery = { keyword, location, page, limit };

  scrapeQueue.enqueue({ id: jobId, sources, query });

  res.status(202).json({
    success: true,
    message: "Scrape job berhasil diantrekan.",
    job_id: jobId,
    status_url: `/api/queue/${jobId}`,
    query,
    sources,
  });
});
