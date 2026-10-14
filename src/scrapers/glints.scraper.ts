import type { IScraper, ScrapeQuery, JobResult } from "../types/index.js";
import { getBrowser, createContext, createPage } from "../utils/browser.js";
import {
  makeJobResult,
  parseEmploymentType,
  parseWorkplaceType,
  parseSalary,
  cleanDescription,
  randomDelay,
  normalizeKeyword,
} from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

/**
 * Glints Indonesia Scraper
 *
 * Uses dual-layer DOM parsing:
 * 1. Primary: accessibility attributes `[aria-label^="Job: "]`
 * 2. Secondary fallback: article wrappers, `[data-gtm-job-id]`, and job title elements
 */
export class GlintsScraper implements IScraper {
  source = "glints" as const;

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const rawKeyword = query.keyword;
    const keyword = normalizeKeyword(rawKeyword);
    const { location, page = 1, limit = 20 } = query;
    const cityName = this.mapLocation(location ?? "");

    const searchUrl =
      `https://glints.com/id/opportunities/jobs/explore` +
      `?keyword=${encodeURIComponent(keyword)}` +
      (cityName ? `&locationName=${encodeURIComponent(cityName)}` : "");

    logger.info("[Glints] Starting scrape", { rawKeyword, keyword, location, page, url: searchUrl });

    const browser = await getBrowser();
    const context = await createContext(browser);
    const browserPage = await createPage(context, { blockResources: false });

    try {
      await browserPage.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await randomDelay(3000, 4500);

      // Scroll to trigger lazy loading of styled-component cards
      await browserPage.evaluate(() => window.scrollBy(0, 800));
      await randomDelay(1500, 2500);

      type GlintsExtractedCard = {
        title: string;
        company: string;
        location: string;
        href: string;
        jobType: string;
        cardText: string;
      };

      const cards: GlintsExtractedCard[] = await browserPage.evaluate(() => {
        const results: {
          title: string;
          company: string;
          location: string;
          href: string;
          jobType: string;
          cardText: string;
        }[] = [];

        // Strategy 1: Check elements with aria-label^="Job: "
        const wrappers = Array.from(document.querySelectorAll('[aria-label^="Job: "]')) as HTMLElement[];

        for (const wrapper of wrappers) {
          const ariaLabel = wrapper.getAttribute("aria-label") ?? "";
          const ariaMatch = ariaLabel.match(/^Job:\s*(.+?),\s*Company:\s*(.+?),\s*Location:\s*(.+)$/);

          const cardContainer = (wrapper.closest('[class*="JobCard"], [class*="Card"]') ?? wrapper) as HTMLElement;
          const titleEl = cardContainer.querySelector('[aria-label^="Job card title:"], h2, h3');
          const title = titleEl ? titleEl.textContent!.replace(/^Job card title:\s*/, "").trim() : (ariaMatch?.[1] ?? "");
          const company = ariaMatch?.[2] ?? cardContainer.querySelector('[class*="Company"], [class*="company"]')?.textContent?.trim() ?? "";
          const location = ariaMatch?.[3] ?? cardContainer.querySelector('[class*="Location"], [class*="location"]')?.textContent?.trim() ?? "";

          const linkEl = cardContainer.querySelector('a[href*="/opportunities/jobs/"]') as HTMLAnchorElement | null;
          const href = linkEl?.href ?? "";
          const gtmId = cardContainer.querySelector("[data-gtm-job-id]")?.getAttribute("data-gtm-job-id") ?? "";
          const jobType = cardContainer.querySelector("[data-gtm-job-type]")?.getAttribute("data-gtm-job-type") ?? "";
          const cardText = cardContainer.innerText ?? "";

          if (title && (company || ariaMatch)) {
            results.push({
              title,
              company: company || "Perusahaan",
              location,
              href: href || (gtmId ? `https://glints.com/id/opportunities/jobs/${gtmId}` : ""),
              jobType,
              cardText,
            });
          }
        }

        // Strategy 2: If aria-labels were not present, fallback to job card links
        if (results.length === 0) {
          const jobLinks = Array.from(document.querySelectorAll('a[href*="/opportunities/jobs/"]')) as HTMLAnchorElement[];
          const seenHrefs = new Set<string>();

          for (const link of jobLinks) {
            const href = link.href.split("?")[0];
            if (!href || seenHrefs.has(href)) continue;
            seenHrefs.add(href);

            const card = (link.closest('[class*="Card"], [class*="card"], [class*="Wrapper"]') ?? link.parentElement?.parentElement) as HTMLElement | null;
            if (!card) continue;

            const title = card.querySelector("h2, h3, [class*='Title']")?.textContent?.trim() ?? link.innerText.trim();
            const company = card.querySelector("[class*='Company'], [class*='company']")?.textContent?.trim() ?? "Perusahaan";
            const location = card.querySelector("[class*='Location'], [class*='location']")?.textContent?.trim() ?? "";

            if (title && title.length > 2) {
              results.push({
                title,
                company,
                location,
                href,
                jobType: "",
                cardText: card.innerText ?? "",
              });
            }
          }
        }

        return results;
      });

      logger.info("[Glints] Extracted cards from page", { count: cards.length });

      const results: JobResult[] = [];

      for (const card of cards.slice(0, limit)) {
        if (!card.title) continue;

        const salaryMatch = card.cardText.match(/Rp\s?[\d,.]+\s?[-–]\s?[\d,.]+jt|Rp\s?[\d,.]+(jt|rb)?/i);
        const salaryRaw = salaryMatch ? salaryMatch[0].trim() : null;
        const { salary_min, salary_max, currency } = parseSalary(
          salaryRaw?.replace(/jt/gi, "000000").replace(/rb/gi, "000") ?? null
        );

        results.push(
          makeJobResult("glints", {
            title: card.title,
            company: card.company,
            location: card.location || location || "Indonesia",
            description: null,
            employment_type: parseEmploymentType(card.jobType || card.cardText),
            workplace_type: card.cardText.toLowerCase().includes("remote")
              ? "remote"
              : card.cardText.toLowerCase().includes("hybrid")
              ? "hybrid"
              : parseWorkplaceType(card.location),
            salary_raw: salaryRaw,
            salary_min,
            salary_max,
            currency,
            source_url: card.href || searchUrl,
            posted_at: null,
          })
        );
      }

      logger.info("[Glints] Scrape completed", { found: results.length });
      return results;
    } catch (err) {
      logger.error("[Glints] Scrape failed", { error: String(err) });
      throw err;
    } finally {
      await browserPage.close();
      await context.close();
    }
  }

  private mapLocation(location: string): string {
    const lower = location.toLowerCase();
    const map: Record<string, string> = {
      jakarta: "Jakarta",
      bandung: "Bandung",
      surabaya: "Surabaya",
      yogyakarta: "Yogyakarta",
      bali: "Bali",
      medan: "Medan",
      semarang: "Semarang",
      remote: "",
      indonesia: "",
    };
    for (const [key, val] of Object.entries(map)) {
      if (lower.includes(key)) return val;
    }
    return location;
  }
}
