import * as cheerio from "cheerio";
import type { IScraper, ScrapeQuery, JobResult } from "../types/index.js";
import { getBrowser, createContext, createPage } from "../utils/browser.js";
import { makeJobResult, parseSalary, parseEmploymentType, parseWorkplaceType, cleanDescription, randomDelay } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

/**
 * JobStreet Indonesia Scraper — Playwright Full Browser
 *
 * JobStreet blocks direct HTTP requests (403 rate limiting + Cloudflare).
 * Strategy: Use Playwright to load the page as a real browser, then
 * parse the rendered HTML or intercept the internal __NEXT_DATA__ JSON
 * embedded in the page (Next.js app), which contains all job listing data.
 *
 * URL: https://www.jobstreet.co.id/{keyword}-jobs/in-{location}?pg={page}
 */
export class JobStreetScraper implements IScraper {
  source = "jobstreet" as const;

  private readonly BASE_URL = "https://www.jobstreet.co.id";

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const { keyword, location = "Indonesia", page = 1, limit = 20 } = query;

    const slug = keyword.toLowerCase().replace(/\s+/g, "-");
    const locSlug = location.toLowerCase().replace(/\s+/g, "-");
    const url = `${this.BASE_URL}/${slug}-jobs/in-${locSlug}?pg=${page}`;

    logger.info("[JobStreet] Starting Playwright scrape", { keyword, location, page, url });

    const browser = await getBrowser();
    const context = await createContext(browser);
    const browserPage = await createPage(context);

    try {
      await browserPage.goto(url, { waitUntil: "domcontentloaded" });
      await randomDelay(2000, 3500);

      // Strategy 1: Extract from __NEXT_DATA__ (embedded JSON in Next.js)
      const nextData = await browserPage.evaluate(() => {
        const el = document.getElementById("__NEXT_DATA__");
        if (!el) return null;
        try { return JSON.parse(el.textContent ?? ""); }
        catch { return null; }
      });

      if (nextData) {
        const results = this.parseNextData(nextData as Record<string, unknown>, limit, location);
        if (results.length > 0) {
          logger.info("[JobStreet] Extracted from __NEXT_DATA__", { found: results.length });
          return results;
        }
      }

      // Strategy 2: Parse rendered HTML
      logger.info("[JobStreet] Falling back to DOM parse");

      // Wait for job cards
      await browserPage
        .waitForSelector("[data-automation='job-card-title']", { timeout: 10000 })
        .catch(() => null);

      await randomDelay(1000, 2000);

      const html = await browserPage.content();
      const results = this.parseHtml(html, limit, location);

      logger.info("[JobStreet] DOM scrape completed", { found: results.length });
      return results;
    } catch (err) {
      logger.error("[JobStreet] Scrape failed", { error: String(err) });
      throw err;
    } finally {
      await browserPage.close();
      await context.close();
    }
  }

  /**
   * Parse Next.js __NEXT_DATA__ blob embedded in the page.
   * JobStreet is a Next.js app — all job data is in this JSON blob.
   */
  private parseNextData(
    data: Record<string, unknown>,
    limit: number,
    fallbackLocation: string
  ): JobResult[] {
    try {
      // Navigate the Next.js data structure
      const pageProps = (data?.props as Record<string, unknown>)?.pageProps as Record<string, unknown>;
      const initialData = pageProps?.initialData ?? pageProps?.data ?? pageProps;

      // Try multiple possible paths for job results in the data tree
      const jobsRaw =
        ((initialData as Record<string, unknown>)?.jobSearchResult as Record<string, unknown>)?.jobs ??
        (initialData as Record<string, unknown>)?.jobs ??
        [];

      if (!Array.isArray(jobsRaw) || jobsRaw.length === 0) return [];

      return (jobsRaw as Record<string, unknown>[]).slice(0, limit).map((job) => {
        const salaryRaw = (job["salary"] as string | null) ?? null;
        const salaryData = parseSalary(salaryRaw);

        return makeJobResult("jobstreet", {
          title: String(job["title"] ?? ""),
          company: String(
            (job["advertiser"] as Record<string, unknown>)?.description ??
            (job["companyName"] ?? "")
          ),
          location: String(
            (job["location"] as Record<string, unknown>)?.label ??
            (job["locationLabel"] ?? fallbackLocation)
          ),
          description: cleanDescription(String(job["teaser"] ?? job["abstract"] ?? "")),
          employment_type: parseEmploymentType(String(job["workType"] ?? job["employmentType"] ?? "")),
          workplace_type: parseWorkplaceType(String(job["workArrangements"] ?? job["locationLabel"] ?? "")),
          salary_raw: salaryRaw,
          ...salaryData,
          source_url: `${this.BASE_URL}/job/${job["id"]}`,
          posted_at: (job["listingDate"] as string | null) ?? null,
        });
      });
    } catch {
      return [];
    }
  }

  /** Parse rendered HTML with Cheerio as final fallback */
  private parseHtml(html: string, limit: number, fallbackLocation: string): JobResult[] {
    const $ = cheerio.load(html);
    const results: JobResult[] = [];

    $("[data-automation='job-card-title']")
      .closest("article")
      .slice(0, limit)
      .each((_, el) => {
        const title = $(el).find("[data-automation='job-card-title']").text().trim();
        const company = $(el).find("[data-automation='job-card-company-name']").text().trim();
        const loc = $(el).find("[data-automation='job-card-location']").text().trim();
        const salaryRaw = $(el).find("[data-automation='job-card-salary']").text().trim() || null;
        const employment = $(el).find("[data-automation='job-card-work-type']").text().trim();
        const href = $(el).find("[data-automation='job-card-title']").attr("href") ?? "";
        const posted = $(el).find("time").attr("datetime") ?? null;

        if (!title || !company) return;

        results.push(
          makeJobResult("jobstreet", {
            title,
            company,
            location: loc || fallbackLocation,
            description: null,
            employment_type: parseEmploymentType(employment),
            workplace_type: parseWorkplaceType(loc + " " + employment),
            salary_raw: salaryRaw,
            ...parseSalary(salaryRaw),
            source_url: href.startsWith("http") ? href : `${this.BASE_URL}${href}`,
            posted_at: posted,
          })
        );
      });

    return results;
  }
}
