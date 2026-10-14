import { scraperRegistry } from "../scrapers/registry.js";
import type { QueuedJob, ScraperSource, ScrapeQuery } from "../types/index.js";
import { logger } from "../utils/logger.js";

const MAX_CONCURRENT = 1; // Run 1 queued scrape job at a time to prevent resource contention

interface EnqueueInput {
  id: string;
  sources: ScraperSource[];
  query: ScrapeQuery;
}

class ScrapeQueue {
  private jobs: Map<string, QueuedJob> = new Map();
  private running = 0;
  private pending: string[] = [];

  enqueue(input: EnqueueInput): void {
    const job: QueuedJob = {
      id: input.id,
      sources: input.sources,
      query: input.query,
      status: "queued",
      created_at: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    logger.info("[Queue] Job enqueued", { id: job.id, sources: job.sources });
    this.tick();
  }

  get(id: string): QueuedJob | undefined {
    return this.jobs.get(id);
  }

  list(): QueuedJob[] {
    return Array.from(this.jobs.values());
  }

  remove(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status === "running") return false;
    this.jobs.delete(id);
    return true;
  }

  private tick(): void {
    while (this.running < MAX_CONCURRENT && this.pending.length > 0) {
      const jobId = this.pending.shift()!;
      const job = this.jobs.get(jobId);
      if (!job) continue;

      this.running++;
      this.execute(job).finally(() => {
        this.running--;
        this.tick();
      });
    }
  }

  private async execute(job: QueuedJob): Promise<void> {
    job.status = "running";
    job.started_at = new Date().toISOString();
    logger.info("[Queue] Job started", { id: job.id });

    const allResults: QueuedJob["result"] = [];
    const errors: string[] = [];

    // Run sources sequentially to ensure stability and reliable card rendering
    for (const source of job.sources) {
      try {
        const scraper = scraperRegistry[source];
        if (!scraper) continue;
        logger.info(`[Queue] Running scraper for source: ${source}`);
        const results = await scraper.scrape(job.query);
        allResults!.push(...results);
        logger.info(`[Queue] Completed source: ${source} with ${results.length} results`);
      } catch (err) {
        errors.push(`${source}: ${String(err)}`);
        logger.error("[Queue] Scraper error", { source, jobId: job.id, error: String(err) });
      }
    }

    job.finished_at = new Date().toISOString();

    if (allResults!.length > 0) {
      job.status = "done";
      job.result = allResults;
      if (errors.length > 0) {
        job.error = `Partial errors: ${errors.join(" | ")}`;
      }
      logger.info("[Queue] Job done", { id: job.id, total: allResults!.length });
    } else {
      job.status = "failed";
      job.error = errors.join(" | ") || "Tidak ada hasil yang berhasil di-scrape.";
      logger.error("[Queue] Job failed", { id: job.id, error: job.error });
    }
  }
}

export const scrapeQueue = new ScrapeQueue();
