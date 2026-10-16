import type { IScraper, ScrapeQuery, JobResult } from "../types/index.js";
import { getBrowser, createContext, createPage, BrowserUnavailableError } from "../utils/browser.js";
import { makeJobResult, parseEmploymentType, parseWorkplaceType, cleanDescription, randomDelay, normalizeKeyword, parsePostedAt } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";
import { load } from "cheerio";

/**
 * LinkedIn Job Scraper
 *
 * Supports dual-mode execution:
 * 1. Playwright Browser (when full headless browser runtime is available)
 * 2. HTTP Guest API Fallback (runs natively in Vercel Serverless Functions via cheerio)
 */
export class LinkedInScraper implements IScraper {
  source = "linkedin" as const;

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const isVercel = process.env.VERCEL === "1";

    // In serverless environments without Chromium, use fast HTTP guest API directly
    if (isVercel) {
      logger.info("[LinkedIn] Vercel detected, running HTTP guest scraper directly");
      return this.scrapeViaHttp(query);
    }

    try {
      return await this.scrapeViaBrowser(query);
    } catch (err) {
      if (err instanceof BrowserUnavailableError || String(err).includes("Executable doesn't exist")) {
        logger.warn("[LinkedIn] Browser unavailable, falling back to HTTP guest scraper");
        return this.scrapeViaHttp(query);
      }
      throw err;
    }
  }

  /**
   * Fast HTTP Scraper using public LinkedIn Guest endpoint.
   * Completely bypasses headless browser requirement — works anywhere including Vercel.
   */
  async scrapeViaHttp(query: ScrapeQuery): Promise<JobResult[]> {
    const rawKeyword = query.keyword;
    const keyword = normalizeKeyword(rawKeyword);
    const { location = "Indonesia", page = 1, limit = 20 } = query;
    const start = (page - 1) * 25;

    const url = new URL("https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search");
    url.searchParams.set("keywords", keyword);
    url.searchParams.set("location", location);
    url.searchParams.set("start", String(start));

    logger.info("[LinkedIn HTTP] Fetching guest listings", { url: url.toString() });

    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });

    if (!res.ok) {
      throw new Error(`LinkedIn Guest API returned HTTP ${res.status}`);
    }

    const html = await res.text();
    const $ = load(html);
    const results: JobResult[] = [];
    const seenUrls = new Set<string>();

    $("li").each((_, item) => {
      if (results.length >= limit) return false;

      const card = $(item);
      const title = card.find(".base-search-card__title, h3").text().trim();
      const company = card.find(".base-search-card__subtitle, h4").text().trim();
      const locationText = card.find(".job-search-card__location").text().trim() || location;
      const rawLink = card.find("a.base-card__full-link, a[href*='/jobs/view/']").attr("href") || "";
      const sourceUrl = rawLink.split("?")[0].trim();
      const timeEl = card.find("time");
      const postedRaw = timeEl.attr("datetime") || timeEl.text().trim() || null;
      const metaText = card.find(".base-search-card__metadata").text().trim();

      if (!title || !company || !sourceUrl) return;
      if (seenUrls.has(sourceUrl)) return;
      seenUrls.add(sourceUrl);

      const { salary_min, salary_max, salary_raw } = extractSalaryFromText(metaText);

      results.push(
        makeJobResult("linkedin", {
          title,
          company,
          location: locationText,
          description: null,
          employment_type: parseEmploymentType(metaText),
          workplace_type: parseWorkplaceType(metaText + " " + locationText),
          salary_raw,
          salary_min,
          salary_max,
          source_url: sourceUrl,
          posted_at: parsePostedAt(postedRaw),
        })
      );
    });

    logger.info("[LinkedIn HTTP] Scrape completed", { count: results.length });
    return results;
  }

  async scrapeViaBrowser(query: ScrapeQuery): Promise<JobResult[]> {
    const rawKeyword = query.keyword;
    const keyword = normalizeKeyword(rawKeyword);
    const { location = "Indonesia", page = 1, limit = 20 } = query;
    const start = (page - 1) * 25;

    const url = new URL("https://www.linkedin.com/jobs/search/");
    url.searchParams.set("keywords", keyword);
    url.searchParams.set("location", location);
    url.searchParams.set("start", String(start));
    url.searchParams.set("f_TPR", "r2592000"); // last 30 days
    url.searchParams.set("sortBy", "R");

    logger.info("[LinkedIn] Starting scrape", { rawKeyword, keyword, location, page, url: url.toString() });

    const browser = await getBrowser();
    const context = await createContext(browser);
    const browserPage = await createPage(context, { blockResources: true });

    try {
      await browserPage.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 20000 });
      await randomDelay(1200, 2000);

      // Wait for any standard LinkedIn job card container
      await browserPage
        .waitForSelector("ul.jobs-search__results-list, div.base-serp-page__content, div.base-search-card", {
          timeout: 8000,
        })
        .catch(() => {
          logger.warn("[LinkedIn] Job list selector timeout, evaluating available DOM");
        });

      // Gentle scroll to ensure initial cards render
      await browserPage.evaluate(() => window.scrollBy(0, 600));
      await randomDelay(600, 1000);

      type RawLinkedInCard = {
        title: string;
        company: string;
        locationText: string | null;
        sourceUrl: string;
        postedRaw: string | null;
        metaText: string;
      };

      const rawCards: RawLinkedInCard[] = await browserPage.evaluate(() => {
        const cards = Array.from(
          document.querySelectorAll("ul.jobs-search__results-list > li, div.base-search-card")
        );

        return cards.map((card) => {
          const title =
            card.querySelector("h3.base-search-card__title, h3, a.base-card__full-link")?.textContent?.trim() ?? "";
          const company =
            card.querySelector("h4.base-search-card__subtitle, h4, a[data-tracking-control-name*='company']")
              ?.textContent?.trim() ?? "";
          const locationText =
            card.querySelector("span.job-search-card__location, span.job-result-card__location")?.textContent?.trim() ??
            null;
          const linkEl = card.querySelector("a.base-card__full-link, a[href*='/jobs/view/']") as HTMLAnchorElement | null;
          const sourceUrl = linkEl?.href ?? "";
          const timeEl = card.querySelector("time");
          const postedRaw = timeEl?.getAttribute("datetime") ?? timeEl?.textContent?.trim() ?? null;
          const metaText = card.querySelector(".base-search-card__metadata")?.textContent?.trim() ?? "";

          return { title, company, locationText, sourceUrl, postedRaw, metaText };
        });
      });

      logger.info("[LinkedIn] Evaluated cards from page", { count: rawCards.length });

      const results: JobResult[] = [];
      const seenUrls = new Set<string>();

      for (const card of rawCards) {
        if (results.length >= limit) break;
        if (!card.title || !card.company || !card.sourceUrl) continue;

        // Normalize URL without query params to avoid duplicate cards on LinkedIn
        const cleanUrl = card.sourceUrl.split("?")[0];
        if (seenUrls.has(cleanUrl)) continue;
        seenUrls.add(cleanUrl);

        const { salary_min, salary_max, salary_raw } = extractSalaryFromText(card.metaText);

        results.push(
          makeJobResult("linkedin", {
            title: card.title,
            company: card.company,
            location: card.locationText || location,
            description: null,
            employment_type: parseEmploymentType(card.metaText),
            workplace_type: parseWorkplaceType(card.metaText + " " + card.locationText),
            salary_raw,
            salary_min,
            salary_max,
            source_url: card.sourceUrl,
            posted_at: parsePostedAt(card.postedRaw),
          })
        );
      }

      logger.info("[LinkedIn] Scrape completed", { found: results.length });
      return results;
    } catch (err) {
      logger.error("[LinkedIn] Scrape failed", { error: String(err) });
      throw err;
    } finally {
      await browserPage.close();
      await context.close();
    }
  }
}

function extractSalaryFromText(text: string): {
  salary_raw: string | null;
  salary_min: number | null;
  salary_max: number | null;
} {
  const salaryMatch = text.match(/(Rp\.?\s?[\d.,]+\s?[-–]\s?Rp\.?\s?[\d.,]+|IDR[\s\d.,]+|USD[\s\d.,]+)/i);
  if (!salaryMatch) return { salary_raw: null, salary_min: null, salary_max: null };

  const raw = salaryMatch[0].trim();
  const nums = raw.replace(/[^0-9.-]/g, " ").trim().split(/\s+/).map(Number).filter(Boolean);
  return {
    salary_raw: raw,
    salary_min: nums[0] ?? null,
    salary_max: nums[1] ?? nums[0] ?? null,
  };
}
