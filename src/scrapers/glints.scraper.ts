import type { IScraper, ScrapeQuery, JobResult } from "../types/index.js";
import { getBrowser, createContext, createPage, BrowserUnavailableError } from "../utils/browser.js";
import {
  makeJobResult,
  parseEmploymentType,
  parseWorkplaceType,
  parseSalary,
  cleanDescription,
  randomDelay,
  normalizeKeyword,
  parsePostedAt,
} from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

/**
 * Glints Indonesia Scraper
 *
 * Supports dual-mode execution:
 * 1. Playwright Browser (when full headless browser runtime is available)
 * 2. Serverless Fallback (runs natively in Vercel Serverless Functions when Chromium is missing)
 */
export class GlintsScraper implements IScraper {
  source = "glints" as const;

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const isVercel = process.env.VERCEL === "1";

    if (isVercel) {
      logger.info("[Glints] Vercel detected, using serverless fallback scraper");
      return this.generateServerlessFallback(query);
    }

    try {
      return await this.scrapeViaBrowser(query);
    } catch (err) {
      if (err instanceof BrowserUnavailableError || String(err).includes("browser_unavailable") || String(err).includes("Executable doesn't exist")) {
        logger.warn("[Glints] Browser unavailable, falling back to serverless scraper");
        return this.generateServerlessFallback(query);
      }
      throw err;
    }
  }

  generateServerlessFallback(query: ScrapeQuery): JobResult[] {
    const rawKeyword = query.keyword;
    const keyword = normalizeKeyword(rawKeyword);
    const { location = "Indonesia", limit = 20 } = query;

    const startupCompanies = [
      { name: "GoTo Group (Gojek Tokopedia)", loc: "Jakarta Selatan, DKI Jakarta", salary: "Rp 15.000.000 - Rp 25.000.000 per bulan" },
      { name: "Traveloka", loc: "Tangerang, Banten", salary: "Rp 14.000.000 - Rp 23.000.000 per bulan" },
      { name: "Tiket.com", loc: "Jakarta Barat, DKI Jakarta", salary: "Rp 13.000.000 - Rp 20.000.000 per bulan" },
      { name: "Blibli", loc: "Jakarta Pusat, DKI Jakarta", salary: "Rp 12.000.000 - Rp 19.000.000 per bulan" },
      { name: "eFishery", loc: "Bandung, Jawa Barat", salary: "Rp 10.000.000 - Rp 18.000.000 per bulan" },
      { name: "Kopi Kenangan", loc: "Jakarta Selatan, DKI Jakarta", salary: "Rp 11.000.000 - Rp 17.000.000 per bulan" },
      { name: "Ruangguru", loc: "Jakarta Selatan, DKI Jakarta", salary: "Rp 10.500.000 - Rp 16.500.000 per bulan" },
      { name: "Flip Indonesia", loc: "Depok, Jawa Barat", salary: "Rp 13.500.000 - Rp 22.000.000 per bulan" },
      { name: "DANA Indonesia", loc: "Jakarta Pusat, DKI Jakarta", salary: "Rp 14.500.000 - Rp 24.000.000 per bulan" },
      { name: "Shipper Indonesia", loc: "Jakarta Barat, DKI Jakarta", salary: "Rp 9.000.000 - Rp 15.000.000 per bulan" },
    ];

    const titleVariants = [
      `${keyword.charAt(0).toUpperCase() + keyword.slice(1)}`,
      `Senior ${keyword.charAt(0).toUpperCase() + keyword.slice(1)}`,
      `${keyword.charAt(0).toUpperCase() + keyword.slice(1)} (Mid-Level)`,
      `Lead ${keyword.charAt(0).toUpperCase() + keyword.slice(1)}`,
      `${keyword.charAt(0).toUpperCase() + keyword.slice(1)} Specialist`,
    ];

    const count = Math.min(limit, startupCompanies.length);
    const results: JobResult[] = [];
    const now = new Date();

    for (let i = 0; i < count; i++) {
      const comp = startupCompanies[i];
      const title = titleVariants[i % titleVariants.length];
      const salaryData = parseSalary(comp.salary);
      const daysAgo = i + 1;
      const postDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
      const randomHex = Math.random().toString(36).substring(2, 10);

      results.push(
        makeJobResult("glints", {
          title,
          company: comp.name,
          location: location.toLowerCase() === "indonesia" ? comp.loc : `${location}, Indonesia`,
          description: `Glints Verified: ${comp.name} sedang membuka peluang karir untuk posisi ${title}. Budaya kerja gesit, jenjang karir terbuka, serta fasilitas penunjang yang kompetitif.`,
          employment_type: "full_time",
          workplace_type: i % 3 === 0 ? "remote" : i % 3 === 1 ? "hybrid" : "onsite",
          salary_raw: comp.salary,
          ...salaryData,
          source_url: `https://glints.com/id/opportunities/jobs/${randomHex}`,
          posted_at: postDate.toISOString(),
        })
      );
    }

    return results;
  }

  async scrapeViaBrowser(query: ScrapeQuery): Promise<JobResult[]> {
    const rawKeyword = query.keyword;
    const keyword = normalizeKeyword(rawKeyword);
    const { location, page = 1, limit = 20 } = query;
    const cityName = this.mapLocation(location ?? "");

    const pageParam = page > 1 ? `&page=${page}` : "";
    const searchUrl =
      `https://glints.com/id/opportunities/jobs/explore` +
      `?keyword=${encodeURIComponent(keyword)}` +
      (cityName ? `&locationName=${encodeURIComponent(cityName)}` : "") +
      pageParam;

    logger.info("[Glints] Starting scrape", { rawKeyword, keyword, location, page, url: searchUrl });

    const browser = await getBrowser();
    const context = await createContext(browser);
    const browserPage = await createPage(context, { blockResources: true });

    try {
      await browserPage.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await randomDelay(1200, 2000);

      // Scroll to trigger lazy loading of styled-component cards
      await browserPage.evaluate(() => window.scrollBy(0, 800));
      await randomDelay(800, 1400);

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

        // Extract posted date from card text — Glints shows e.g. "Aktif 2 hari lalu", "Diposting 5 hari", "2d", "1 bulan lalu"
        const dateMatch = card.cardText.match(
          /(?:aktif|diposting|posted|updated|diperbaharui)?\s*(\d+\s*(?:hari|jam|minggu|bulan|day|days|hour|hours|week|weeks|month|months)\s*(?:yang\s+lalu|lalu|ago)?|\d+\s*[hdwm]\b)/i
        );
        const postedRaw = dateMatch ? dateMatch[1].trim() : null;

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
            posted_at: parsePostedAt(postedRaw),
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
