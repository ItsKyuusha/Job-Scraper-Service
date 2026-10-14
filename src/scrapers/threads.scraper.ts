import { getBrowser, createContext, createPage } from "../utils/browser.js";
import type { IScraper, ScrapeQuery, JobResult } from "../types/index.js";
import { makeJobResult, parseEmploymentType, parseWorkplaceType, parseSalary, cleanDescription, randomDelay } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

/**
 * Threads Job Scraper
 *
 * Scrapes job postings from Threads (threads.net) using hashtag search.
 * Threads does not have a dedicated jobs section — job posts are
 * typically tagged with #lowongankerja #loker #hiring etc.
 *
 * Since Threads is JS-rendered and requires a session for full content,
 * we scrape the public profile/tag pages using Playwright.
 *
 * Extracted fields are best-effort from post text via NLP-lite regex patterns.
 */
export class ThreadsScraper implements IScraper {
  source = "threads" as const;

  private readonly HASHTAGS = ["lowongankerja", "loker", "hiring", "jobopening"];

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const { keyword, page = 1, limit = 20 } = query;

    // Combine keyword with job hashtag for targeted results
    const hashtag = this.pickHashtag(keyword);
    const url = `https://www.threads.net/search?q=${encodeURIComponent(hashtag + " " + keyword)}&serp_type=default`;

    logger.info("[Threads] Starting scrape", { keyword, hashtag, page });

    const browser = await getBrowser();
    const context = await createContext(browser);
    const browserPage = await createPage(context);

    try {
      await browserPage.goto(url, { waitUntil: "domcontentloaded" });
      await randomDelay(2500, 4000);

      // Scroll to load more posts
      for (let i = 0; i < Math.min(page, 3); i++) {
        await browserPage.evaluate(() => window.scrollBy(0, 1200));
        await randomDelay(1000, 2000);
      }

      // Wait for post elements
      await browserPage
        .waitForSelector("[class*='x1cy8zhl']", { timeout: 10000 })
        .catch(() => logger.warn("[Threads] Post selector not found, trying generic"));

      // Collect all visible post texts
      const postTexts = await browserPage.evaluate(() => {
        const posts: { text: string; url: string }[] = [];
        // Try multiple possible selectors for Threads posts
        const selectors = [
          "article[role='article']",
          "[data-testid='postContainer']",
          "div[class*='x1ywc1zp']",
        ];

        for (const sel of selectors) {
          const elements = document.querySelectorAll(sel);
          if (elements.length === 0) continue;

          elements.forEach((el) => {
            const text = (el as HTMLElement).innerText?.trim() ?? "";
            const link = el.querySelector("a[href*='/post/']") as HTMLAnchorElement | null;
            const url = link?.href ?? "";
            if (text.length > 50) {
              posts.push({ text, url });
            }
          });
          if (posts.length > 0) break;
        }
        return posts;
      });

      logger.info("[Threads] Found raw posts", { count: postTexts.length });

      const results: JobResult[] = [];

      for (const { text, url: postUrl } of postTexts.slice(0, limit * 2)) {
        // Filter: only process posts that look like job postings
        if (!this.looksLikeJobPost(text, keyword)) continue;

        const parsed = this.parseJobFromText(text);
        if (!parsed.title) continue;

        results.push(
          makeJobResult("threads", {
            title: parsed.title,
            company: parsed.company,
            location: parsed.location,
            description: cleanDescription(text),
            employment_type: parseEmploymentType(text),
            workplace_type: parseWorkplaceType(text),
            salary_raw: parsed.salaryRaw,
            ...parseSalary(parsed.salaryRaw),
            source_url: postUrl || url,
            posted_at: null, // Threads doesn't expose timestamp on public search
          })
        );

        if (results.length >= limit) break;
      }

      logger.info("[Threads] Scrape completed", { found: results.length });
      return results;
    } catch (err) {
      logger.error("[Threads] Scrape failed", { error: String(err) });
      throw err;
    } finally {
      await browserPage.close();
      await context.close();
    }
  }

  /** Check if post text is likely a job posting */
  private looksLikeJobPost(text: string, keyword: string): boolean {
    const lower = text.toLowerCase();
    const jobSignals = [
      "loker", "lowongan", "hiring", "dicari", "dibutuhkan",
      "open position", "join us", "we are looking", "requirement",
      "kualifikasi", "apply", "kirim cv", "lamaran",
    ];
    const hasJobSignal = jobSignals.some((s) => lower.includes(s));
    const hasKeyword = lower.includes(keyword.toLowerCase());
    return hasJobSignal && (hasKeyword || lower.includes("engineer") || lower.includes("developer"));
  }

  /** Extract structured fields from free-form post text */
  private parseJobFromText(text: string): {
    title: string;
    company: string;
    location: string | null;
    salaryRaw: string | null;
  } {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    // Title: usually first meaningful line
    const titleLine = lines.find((l) =>
      l.match(/^(open|hiring|lowongan|dicari|dibutuhkan|we are looking)/i) ??
      l.match(/(engineer|developer|designer|analyst|manager|staff|officer|intern)/i)
    ) ?? lines[0] ?? "";
    const title = titleLine.replace(/^(open|hiring|lowongan):?\s*/i, "").trim().slice(0, 120);

    // Company: look for "PT", "CV", "@company" patterns
    const companyMatch = text.match(/(?:PT\.?\s+|CV\.?\s+|@)([A-Z][A-Za-z\s]{2,30})/);
    const company = companyMatch ? companyMatch[0].trim() : "Tidak Diketahui";

    // Location: look for kota/wilayah keywords
    const locationMatch = text.match(
      /(?:lokasi|tempat|location|daerah)[\s:]+([A-Z][A-Za-z\s,]{2,40})/i
    ) ?? text.match(/\b(Jakarta|Bandung|Surabaya|Bali|Yogyakarta|Semarang|Medan|Remote|WFH)\b/i);
    const location = locationMatch ? locationMatch[1]?.trim() ?? locationMatch[0].trim() : null;

    // Salary
    const salaryMatch = text.match(
      /(Rp\.?\s?[\d.,]+\s?[-–]\s?Rp\.?\s?[\d.,]+|[\d]+ ?[Jj]t|gaji[\s:]+[\d., Rp]+)/i
    );
    const salaryRaw = salaryMatch ? salaryMatch[0].trim() : null;

    return { title, company, location, salaryRaw };
  }

  /** Pick relevant hashtag based on keyword */
  private pickHashtag(keyword: string): string {
    const lower = keyword.toLowerCase();
    if (lower.includes("magang") || lower.includes("intern")) return "#lokermagang";
    if (lower.includes("remote") || lower.includes("wfh")) return "#lokerremote";
    return "#loker";
  }
}
