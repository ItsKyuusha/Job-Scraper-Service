import type { IScraper, ScrapeQuery, JobResult } from "../types/index.js";
import { getBrowser, createContext, createPage } from "../utils/browser.js";
import {
  makeJobResult,
  parseSalary,
  parseEmploymentType,
  parseWorkplaceType,
  cleanDescription,
  randomDelay,
} from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

/**
 * JobStreet Indonesia Scraper
 *
 * Site uses `id.jobstreet.com/id/{keyword}-jobs` format.
 * Renders listings with `origin=cardTitle` links inside article wrappers.
 */
export class JobStreetScraper implements IScraper {
  source = "jobstreet" as const;

  private readonly BASE_URL = "https://id.jobstreet.com";

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const { keyword, location = "indonesia", page = 1, limit = 20 } = query;

    const slug = keyword.toLowerCase().trim().replace(/\s+/g, "-");
    const isGenericLocation = !location || location.toLowerCase() === "indonesia";
    const locSlug = isGenericLocation ? "" : `/in-${location.toLowerCase().trim().replace(/\s+/g, "-")}`;
    const pageParam = page > 1 ? `?page=${page}` : "";

    const url = `${this.BASE_URL}/id/${slug}-jobs${locSlug}${pageParam}`;

    logger.info("[JobStreet] Navigating to search URL", { keyword, location, page, url });

    const browser = await getBrowser();
    const context = await createContext(browser);
    // Do NOT block resources on JobStreet to allow full hydration
    const browserPage = await createPage(context, { blockResources: false });

    try {
      await browserPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await randomDelay(3500, 5000);

      // Wait for card title links to appear
      await browserPage
        .waitForSelector('a[href*="origin=cardTitle"], article', { timeout: 15000 })
        .catch(() => logger.warn("[JobStreet] Card selector timeout, proceeding with whatever is rendered"));

      type RawCard = {
        title: string;
        href: string;
        lines: string[];
      };

      const rawCards: RawCard[] = await browserPage.evaluate(() => {
        const titleLinks = Array.from(document.querySelectorAll('a[href*="origin=cardTitle"]')) as HTMLAnchorElement[];

        if (titleLinks.length > 0) {
          return titleLinks.map((link) => {
            const container = (link.closest("article") ?? link.closest("[data-card-type]") ?? link.parentElement?.parentElement?.parentElement) as HTMLElement | null;
            return {
              title: link.innerText.trim(),
              href: link.href.split("?")[0],
              lines: container ? container.innerText.split("\n").map((l) => l.trim()).filter(Boolean) : [],
            };
          });
        }

        const fallbackLinks = Array.from(document.querySelectorAll('a[href*="/id/job/"]')) as HTMLAnchorElement[];
        const seen = new Set<string>();
        const results: { title: string; href: string; lines: string[] }[] = [];

        for (const link of fallbackLinks) {
          const cleanHref = link.href.split("?")[0];
          const text = link.innerText.trim();
          if (!cleanHref || !text || seen.has(cleanHref)) continue;
          seen.add(cleanHref);

          const container = (link.closest("article") ?? link.parentElement?.parentElement) as HTMLElement | null;
          results.push({
            title: text,
            href: cleanHref,
            lines: container ? container.innerText.split("\n").map((l) => l.trim()).filter(Boolean) : [],
          });
        }

        return results;
      });

      logger.info("[JobStreet] Raw cards extracted from DOM", { count: rawCards.length });

      const results: JobResult[] = [];

      for (const card of rawCards.slice(0, limit)) {
        if (!card.title || !card.href) continue;

        let company = "Tidak Diketahui";
        let locationFound = location;
        let salaryRaw: string | null = null;
        let employmentRaw: string | null = null;
        let description: string | null = null;

        for (let i = 0; i < card.lines.length; i++) {
          const line = card.lines[i];

          if (line.toLowerCase() === "di" && card.lines[i + 1]) {
            company = card.lines[i + 1].replace(/\s*\([A-Za-z\s,]+\)$/, "").trim();
          }

          if (/Rp\s?[\d.,]+\s?[-–]\s?Rp\s?[\d.,]+|[\d.,]+\s?per\s?month/i.test(line)) {
            salaryRaw = line;
          }

          if (/lowongan kerja\s+(Full time|Part time|Kontrak|Contract|Magang|Internship)/i.test(line)) {
            employmentRaw = line;
          }

          if (/(Jakarta|Bandung|Surabaya|Bali|Yogyakarta|Semarang|Medan|Tangerang|Bekasi|Bogor|Depok|Indonesia|Remote|Hibrid)/i.test(line) && !line.includes("lowongan") && !line.includes("Rp")) {
            if (locationFound === location) {
              locationFound = line;
            }
          }

          if (line.length > 50 && !line.includes("classification") && !line.includes("subClassification")) {
            if (!description) description = line;
          }
        }

        const salaryData = parseSalary(salaryRaw);

        results.push(
          makeJobResult("jobstreet", {
            title: card.title,
            company,
            location: locationFound,
            description: cleanDescription(description),
            employment_type: parseEmploymentType(employmentRaw ?? card.lines.join(" ")),
            workplace_type: parseWorkplaceType(locationFound + " " + (employmentRaw ?? "")),
            salary_raw: salaryRaw,
            ...salaryData,
            source_url: card.href,
            posted_at: null,
          })
        );
      }

      logger.info("[JobStreet] Scrape completed successfully", { found: results.length });
      return results;
    } catch (err) {
      logger.error("[JobStreet] Scrape failed", { error: String(err) });
      throw err;
    } finally {
      await browserPage.close();
      await context.close();
    }
  }
}
