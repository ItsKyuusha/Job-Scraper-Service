import axios from "axios";
import * as cheerio from "cheerio";
import type { IScraper, ScrapeQuery, JobResult } from "../types/index.js";
import { makeJobResult, parseSalary, parseEmploymentType, parseWorkplaceType, cleanDescription, randomDelay } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

/**
 * JobStreet Indonesia Scraper
 *
 * JobStreet renders listings server-side so we can use Axios + Cheerio
 * (faster, no browser overhead) for most pages.
 *
 * URL pattern:
 *   https://www.jobstreet.co.id/jobs/{keyword}-jobs/in-{location}?pg={page}
 *   or: https://www.jobstreet.co.id/api/chalice-search/v4/search?...
 */
export class JobStreetScraper implements IScraper {
  source = "jobstreet" as const;

  private readonly BASE_URL = "https://www.jobstreet.co.id";

  private readonly HEADERS = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.jobstreet.co.id/",
  };

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const { keyword, location = "Indonesia", page = 1, limit = 20 } = query;

    // Try the JSON API endpoint first (cleaner data)
    const apiResults = await this.scrapeViaApi(keyword, location, page, limit);
    if (apiResults.length > 0) return apiResults;

    // Fallback to HTML scraping
    return this.scrapeViaHtml(keyword, location, page, limit);
  }

  private async scrapeViaApi(
    keyword: string,
    location: string,
    page: number,
    limit: number
  ): Promise<JobResult[]> {
    // JobStreet uses a Chalice Search API internally
    const apiUrl = `${this.BASE_URL}/api/chalice-search/v4/search`;
    const params = {
      siteKey: "ID",
      sourcesystem: "houston",
      userqueryid: `${Date.now()}`,
      userid: "",
      usersessionid: "",
      eventCaptureSessionId: "",
      where: location,
      page: String(page),
      keywords: keyword,
      seekSelectAllPages: "true",
      hadPremiumListings: "false",
      pageSize: String(Math.min(limit, 30)),
      include: "seodata",
    };

    logger.info("[JobStreet] Trying API endpoint", { keyword, location, page });

    try {
      await randomDelay(500, 1500);
      const res = await axios.get(apiUrl, {
        params,
        headers: {
          ...this.HEADERS,
          "X-Seek-Site": "jobstreet-id",
          "Accept": "application/json",
        },
        timeout: 20000,
      });

      const data = res.data as Record<string, unknown>;
      const jobs = (data?.data as Record<string, unknown>[])?.[0]?.["jobs"] as Record<string, unknown>[] ?? [];

      if (!Array.isArray(jobs) || jobs.length === 0) return [];

      return jobs.slice(0, limit).map((job) => {
        const salaryData = parseSalary((job["salary"] as string | null) ?? null);
        return makeJobResult("jobstreet", {
          title: String(job["title"] ?? ""),
          company: String((job["advertiser"] as Record<string, unknown>)?.["description"] ?? ""),
          location: String((job["location"] as Record<string, unknown>)?.["label"] ?? location),
          description: cleanDescription(String(job["teaser"] ?? "")),
          employment_type: parseEmploymentType(String(job["workType"] ?? "")),
          workplace_type: parseWorkplaceType(String(job["workArrangements"] ?? "")),
          salary_raw: (job["salary"] as string | null) ?? null,
          ...salaryData,
          source_url: `${this.BASE_URL}/job/${job["id"]}`,
          posted_at: (job["listingDate"] as string | null) ?? null,
        });
      });
    } catch (apiErr) {
      logger.warn("[JobStreet] API endpoint failed, falling back to HTML", {
        error: String(apiErr),
      });
      return [];
    }
  }

  private async scrapeViaHtml(
    keyword: string,
    location: string,
    page: number,
    limit: number
  ): Promise<JobResult[]> {
    const slug = keyword.toLowerCase().replace(/\s+/g, "-");
    const locSlug = location.toLowerCase().replace(/\s+/g, "-");
    const url = `${this.BASE_URL}/${slug}-jobs/in-${locSlug}?pg=${page}`;

    logger.info("[JobStreet] Scraping HTML", { url });

    try {
      await randomDelay(800, 2000);
      const res = await axios.get(url, {
        headers: this.HEADERS,
        timeout: 20000,
      });

      const $ = cheerio.load(res.data as string);
      const results: JobResult[] = [];

      // JobStreet job cards
      $("[data-automation='job-card-title']")
        .closest("article")
        .slice(0, limit)
        .each((_, el) => {
          const title = $(el).find("[data-automation='job-card-title']").text().trim();
          const company = $(el).find("[data-automation='job-card-company-name']").text().trim();
          const loc = $(el).find("[data-automation='job-card-location']").text().trim();
          const salaryRaw = $(el).find("[data-automation='job-card-salary']").text().trim() || null;
          const employment = $(el).find("[data-automation='job-card-work-type']").text().trim();
          const jobHref = $(el).find("[data-automation='job-card-title']").attr("href") ?? "";
          const posted = $(el).find("time").attr("datetime") ?? null;

          if (!title || !company) return;

          const salaryData = parseSalary(salaryRaw);

          results.push(
            makeJobResult("jobstreet", {
              title,
              company,
              location: loc || location,
              description: null,
              employment_type: parseEmploymentType(employment),
              workplace_type: parseWorkplaceType(loc + " " + employment),
              salary_raw: salaryRaw,
              ...salaryData,
              source_url: jobHref.startsWith("http") ? jobHref : `${this.BASE_URL}${jobHref}`,
              posted_at: posted,
            })
          );
        });

      logger.info("[JobStreet] HTML scrape completed", { found: results.length });
      return results;
    } catch (err) {
      logger.error("[JobStreet] HTML scrape failed", { error: String(err) });
      throw err;
    }
  }
}
