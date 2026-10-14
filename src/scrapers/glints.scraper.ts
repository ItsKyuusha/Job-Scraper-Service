import type { IScraper, ScrapeQuery, JobResult } from "../types/index.js";
import { getBrowser, createContext, createPage } from "../utils/browser.js";
import {
  makeJobResult,
  parseEmploymentType,
  parseWorkplaceType,
  parseSalary,
  cleanDescription,
  randomDelay,
} from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

/**
 * Glints Indonesia Scraper — DOM Parsing via Aria Labels
 *
 * Diagnosis result:
 * - GraphQL intercept only captures location endpoint, NOT job search
 * - But Glints renders job cards in the DOM using a stable structure:
 *   - Wrapper: div[role="article"][aria-label^="Job: "]
 *   - Title:   a[aria-label^="Job card title:"]  OR  h2.CompactJobTitle
 *   - Job ID:  data-gtm-job-id attribute
 *   - Type:    data-gtm-job-type attribute
 *   - Meta:    innerText of card contains salary, type, experience on separate lines
 *
 * Strategy: navigate to search page, wait for cards, parse DOM with page.evaluate()
 */
export class GlintsScraper implements IScraper {
  source = "glints" as const;

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const { keyword, location, page = 1, limit = 20 } = query;
    const cityName = this.mapLocation(location ?? "");

    const searchUrl =
      `https://glints.com/id/opportunities/jobs/explore` +
      `?keyword=${encodeURIComponent(keyword)}` +
      (cityName ? `&locationName=${encodeURIComponent(cityName)}` : "");

    logger.info("[Glints] Starting DOM scrape", { keyword, location, page, url: searchUrl });

    const browser = await getBrowser();
    const context = await createContext(browser);
    const browserPage = await createPage(context);

    try {
      await browserPage.goto(searchUrl, { waitUntil: "domcontentloaded" });

      // Wait for job cards to appear in DOM
      // Glints renders with styled-components so class names are hashed,
      // but aria-label is stable
      await browserPage
        .waitForSelector('[aria-label^="Job card title:"], [aria-label^="Job:"]', { timeout: 15000 })
        .catch(() => logger.warn("[Glints] Job card selector timeout, trying anyway"));

      await randomDelay(2000, 3000);

      // Scroll a bit to trigger lazy loading of more cards
      await browserPage.evaluate(() => window.scrollBy(0, 800));
      await randomDelay(1000, 1500);

      // Extract job data from DOM
      type CardData = {
        jobId: string;
        ariaLabel: string;
        title: string;
        company: string;
        location: string;
        href: string;
        jobType: string;
        cardText: string;
      };

      const cards: CardData[] = await browserPage.evaluate(() => {
        const results: {
          jobId: string;
          ariaLabel: string;
          title: string;
          company: string;
          location: string;
          href: string;
          jobType: string;
          cardText: string;
        }[] = [];

        // Primary selector: the outer wrapper with job meta in aria-label
        // "Job: Frontend Developer, Company: PT Sigma, Location: Setiabudi"
        const wrappers = Array.from(
          document.querySelectorAll('[aria-label^="Job: "]')
        ) as HTMLElement[];

        wrappers.forEach((wrapper) => {
          const ariaLabel = wrapper.getAttribute("aria-label") ?? "";

          // Parse from aria-label (very reliable source)
          const ariaMatch = ariaLabel.match(
            /^Job:\s*(.+?),\s*Company:\s*(.+?),\s*Location:\s*(.+)$/
          );

          // Find the card link container
          const cardContainer = wrapper.closest(
            '[class*="CompactJobCard"]'
          ) as HTMLElement | null ?? wrapper;

          // Job title from dedicated aria-label link
          const titleEl = cardContainer.querySelector('[aria-label^="Job card title:"]');
          const title = titleEl
            ? titleEl.getAttribute("aria-label")!.replace(/^Job card title:\s*/, "").trim()
            : (ariaMatch?.[1] ?? "");

          const company = ariaMatch?.[2] ?? "";
          const location = ariaMatch?.[3] ?? "";

          // Job ID from GTM data attribute
          const jobIdEl = cardContainer.querySelector("[data-gtm-job-id]");
          const jobId = jobIdEl?.getAttribute("data-gtm-job-id") ?? "";

          // Job type from GTM attribute
          const jobType = jobIdEl?.getAttribute("data-gtm-job-type") ?? "";

          // Link href
          const linkEl = titleEl?.closest("a") as HTMLAnchorElement | null
            ?? cardContainer.querySelector("a[href*='/opportunities/jobs/']") as HTMLAnchorElement | null;
          const href = linkEl?.href ?? `https://glints.com/id/opportunities/jobs/${jobId}`;

          // Full card text (contains salary, work type, experience, etc.)
          const cardText = cardContainer.innerText ?? "";

          if (title && company) {
            results.push({ jobId, ariaLabel, title, company, location, href, jobType, cardText });
          }
        });

        return results;
      });

      logger.info("[Glints] Cards extracted from DOM", { count: cards.length });

      if (cards.length === 0) {
        logger.warn("[Glints] No cards found, trying fallback selectors");
        return await this.parseFallback(browserPage, limit, location ?? "Indonesia", keyword);
      }

      // Parse the cardText to extract salary, employment type, workplace type
      const results: JobResult[] = cards.slice(0, limit).map((card) => {
        const salaryMatch = card.cardText.match(
          /Rp\s?[\d,.]+\s?[-–]\s?[\d,.]+jt|Rp\s?[\d,.]+(jt|rb)?/i
        );
        const salaryRaw = salaryMatch ? salaryMatch[0].trim() : null;
        const { salary_min, salary_max, currency } = parseSalary(
          salaryRaw?.replace(/jt/gi, "000000").replace(/rb/gi, "000") ?? null
        );

        return makeJobResult("glints", {
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
          source_url: card.href || `https://glints.com/id/opportunities/jobs/${card.jobId}`,
          posted_at: null,
        });
      });

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

  /** Last-resort: parse whatever text content we can find */
  private async parseFallback(
    page: import("playwright").Page,
    limit: number,
    fallbackLocation: string,
    keyword: string
  ): Promise<JobResult[]> {
    try {
      type FallbackCard = { title: string; company: string; text: string; href: string };
      const cards: FallbackCard[] = await page.evaluate(() => {
        const results: { title: string; company: string; text: string; href: string }[] = [];

        // Try h2 job titles
        const h2s = Array.from(document.querySelectorAll("h2")) as HTMLElement[];
        h2s.forEach((h2) => {
          const text = h2.innerText.trim();
          if (text.length < 3 || text.length > 150) return;
          const card = h2.closest('[class*="Card"], [class*="Job"], [class*="Opportunity"]') as HTMLElement | null;
          const cardText = card?.innerText ?? "";
          const link = (h2.closest("a") ?? card?.querySelector("a")) as HTMLAnchorElement | null;

          // Try to find company near the title
          const companyEl = card?.querySelector('[class*="company"], [class*="Company"]') as HTMLElement | null;

          results.push({
            title: text,
            company: companyEl?.innerText.trim() ?? "",
            text: cardText.slice(0, 500),
            href: link?.href ?? "",
          });
        });

        return results.filter((r) => r.title.length > 2).slice(0, 30);
      });

      return cards.slice(0, limit).map((c) =>
        makeJobResult("glints", {
          title: c.title,
          company: c.company || "Tidak Diketahui",
          location: fallbackLocation,
          description: cleanDescription(c.text),
          employment_type: parseEmploymentType(c.text),
          workplace_type: parseWorkplaceType(c.text),
          salary_raw: null,
          salary_min: null,
          salary_max: null,
          source_url:
            c.href ||
            `https://glints.com/id/opportunities/jobs/explore?keyword=${encodeURIComponent(keyword)}`,
          posted_at: null,
        })
      );
    } catch {
      return [];
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
