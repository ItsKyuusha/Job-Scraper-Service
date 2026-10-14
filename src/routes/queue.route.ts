import { Router, Request, Response } from "express";
import { scrapeQueue } from "../queue/scrape-queue.js";

export const queueRouter = Router();

// ─── GET /api/queue ───────────────────────────────────────────────────────────
/**
 * List all queued/running/completed jobs (last 50).
 */
queueRouter.get("/", (_req: Request, res: Response) => {
  const jobs = scrapeQueue.list();
  res.json({
    success: true,
    total: jobs.length,
    jobs: jobs.slice(-50).reverse(),
  });
});

// ─── GET /api/queue/:id ───────────────────────────────────────────────────────
/**
 * Get status and results of a specific queued scrape job.
 */
queueRouter.get("/:id", (req: Request, res: Response) => {
  const jobId = Array.isArray(req.params["id"]) ? req.params["id"][0] : req.params["id"];
  const job = scrapeQueue.get(jobId);

  if (!job) {
    res.status(404).json({ success: false, error: "Job tidak ditemukan." });
    return;
  }

  res.json({
    success: true,
    job: {
      id: job.id,
      status: job.status,
      sources: job.sources,
      query: job.query,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      total_results: job.result?.length ?? 0,
      results: job.status === "done" ? job.result : undefined,
      error: job.error,
    },
  });
});

// ─── DELETE /api/queue/:id ────────────────────────────────────────────────────
/**
 * Remove a completed or failed job from the queue store.
 */
queueRouter.delete("/:id", (req: Request, res: Response) => {
  const delId = Array.isArray(req.params["id"]) ? req.params["id"][0] : req.params["id"];
  const removed = scrapeQueue.remove(delId);
  if (!removed) {
    res.status(404).json({ success: false, error: "Job tidak ditemukan." });
    return;
  }
  res.json({ success: true, message: "Job dihapus." });
});
