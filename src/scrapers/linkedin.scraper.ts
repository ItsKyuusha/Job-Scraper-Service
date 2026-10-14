import type { IScraper, ScrapeQuery, JobResult } from "../types/index.js";
import { getBrowser, createContext, createPage } from "../utils/browser.js";
import { makeJobResult, parseEmploymentType, parseWorkplaceType, cleanDescription, randomDelay } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

/**
 * LinkedIn Job Scraper
 *
 * Scrapes from LinkedIn public job search (no login required for listings).
 * Uses Playwright + Stealth to bypass bot detection.
 *
 * LinkedIn URL pattern:
 *   https://www.linkedin.com/jobs/search/?keywords={keyword}&location={location}&start={offset}
 */
export class LinkedInScraper implements IScraper {
  source = "linkedin" as const;

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const { keyword, location = "Indonesia", page = 1, limit = 20 } = query;
    const start = (page - 1) * 25; // LinkedIn paginates by 25

    const url = new URL("https://www.linkedin.com/jobs/search/");
    url.searchParams.set("keywords", keyword);
    url.searchParams.set("location", location);
    url.searchParams.set("start", String(start));
    url.searchParams.set("f_TPR", "r2592000"); // last 30 days
    url.searchParams.set("sortBy", "R"); // relevance

    logger.info("[LinkedIn] Starting scrape", { keyword, location, page });

    const browser = await getBrowser();
    const context = await createContext(browser);
    const browserPage = await createPage(context);

    try {
      await browserPage.goto(url.toString(), { waitUntil: "domcontentloaded" });
      await randomDelay(1500, 3000);

      // Wait for job cards to appear
      await browserPage
        .waitForSelector("ul.jobs-search__results-list li", { timeout: 15000 })
        .catch(() => {
          logger.warn("[LinkedIn] Job list selector not found, trying alternative");
        });

      const results: JobResult[] = [];

      // Scrape job cards from the listings page
      const cards = await browserPage.$$("ul.jobs-search__results-list > li");

      for (const card of cards.slice(0, limit)) {
        try {
          const title = await card.$eval(
            "h3.base-search-card__title",
            (el) => el.textContent?.trim() ?? ""
          ).catch(() => "");

          const company = await card.$eval(
            "h4.base-search-card__subtitle",
            (el) => el.textContent?.trim() ?? ""
          ).catch(() => "");

          const locationText = await card.$eval(
            "span.job-search-card__location",
            (el) => el.textContent?.trim() ?? null
          ).catch(() => null);

          const sourceUrl = await card.$eval(
            "a.base-card__full-link",
            (el) => (el as HTMLAnchorElement).href
          ).catch(() => "");

          const postedRaw = await card.$eval(
            "time",
            (el) => el.getAttribute("datetime") ?? el.textContent?.trim() ?? null
          ).catch(() => null);

          const metaText = await card.$eval(
            ".base-search-card__metadata",
            (el) => el.textContent?.trim() ?? ""
          ).catch(() => "");

          if (!title || !company || !sourceUrl) continue;

          const { salary_min, salary_max, salary_raw } = extractSalaryFromText(metaText);

          results.push(
            makeJobResult("linkedin", {
              title,
              company,
              location: locationText,
              description: null, // detail page not fetched in list mode
              employment_type: parseEmploymentType(metaText),
              workplace_type: parseWorkplaceType(metaText + " " + locationText),
              salary_raw,
              salary_min,
              salary_max,
              source_url: sourceUrl,
              posted_at: postedRaw,
            })
          );
        } catch (cardErr) {
          logger.debug("[LinkedIn] Error parsing card", { error: String(cardErr) });
          continue;
        }
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
