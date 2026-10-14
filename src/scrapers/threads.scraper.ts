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
 * Threads Job Scraper
 *
 * Threads (`threads.com`) tag pages (e.g. `/tag/loker`, `/tag/lowongankerja`)
 * are open publicly and show active community job listings.
 *
 * Each post has a permalink matching `/post/` and text content detailing
 * the vacancy, requirements, and contact/DM info.
 */
export class ThreadsScraper implements IScraper {
  source = "threads" as const;

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const { keyword, page = 1, limit = 20 } = query;

    const tags = this.selectTags(keyword);
    logger.info("[Threads] Starting public tag scrape", { keyword, tags, page });

    const browser = await getBrowser();
    const context = await createContext(browser);
    const browserPage = await createPage(context, { blockResources: false });

    const results: JobResult[] = [];
    const seenUrls = new Set<string>();

    try {
      for (const tag of tags) {
        if (results.length >= limit) break;

        const url = `https://www.threads.com/tag/${tag}`;
        logger.info("[Threads] Navigating to tag page", { tag, url });

        try {
          await browserPage.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
          await randomDelay(3000, 4500);

          // Scroll down to load more dynamic threads
          const scrollCount = Math.min(Math.max(page * 2, 2), 5);
          for (let i = 0; i < scrollCount; i++) {
            await browserPage.evaluate(() => window.scrollBy(0, 1200));
            await randomDelay(1200, 2000);
          }

          type ScrapedPost = {
            postUrl: string;
            author: string;
            text: string;
          };

          const posts: ScrapedPost[] = await browserPage.evaluate(() => {
            const items: { postUrl: string; author: string; text: string }[] = [];
            const seen = new Set<string>();

            // Find all anchor elements linking to posts
            const postLinks = Array.from(document.querySelectorAll('a[href*="/post/"]')) as HTMLAnchorElement[];

            for (const a of postLinks) {
              const href = a.href.split("?")[0];
              if (!href || seen.has(href)) continue;

              // Walk up parents to find the post content card
              let container: HTMLElement | null = a.parentElement;
              while (
                container &&
                container.innerText &&
                container.innerText.length < 60 &&
                container !== document.body
              ) {
                container = container.parentElement;
              }

              const fullText = (container?.innerText ?? a.innerText ?? "").trim();
              if (fullText.length < 25) continue;

              seen.add(href);

              // Extract author username from post URL: https://www.threads.com/@username/post/xxx
              const authorMatch = href.match(/@([^/]+)/);
              const author = authorMatch ? `@${authorMatch[1]}` : "";

              items.push({ postUrl: href, author, text: fullText });
            }

            return items;
          });

          logger.info("[Threads] Extracted post candidates from tag", { tag, count: posts.length });

          for (const post of posts) {
            if (results.length >= limit) break;
            if (seenUrls.has(post.postUrl)) continue;

            // Check if post text contains relevant job opening signals
            if (!this.isJobOpening(post.text, keyword)) continue;

            seenUrls.add(post.postUrl);

            const parsed = this.parseJobFromText(post.text, post.author);
            if (!parsed.title) continue;

            const salaryData = parseSalary(parsed.salaryRaw);

            results.push(
              makeJobResult("threads", {
                title: parsed.title,
                company: parsed.company || post.author || "Info via Threads",
                location: parsed.location,
                description: cleanDescription(post.text),
                employment_type: parseEmploymentType(post.text),
                workplace_type: parseWorkplaceType(post.text),
                salary_raw: parsed.salaryRaw,
                ...salaryData,
                source_url: post.postUrl,
                posted_at: null,
              })
            );
          }
        } catch (tagErr) {
          logger.warn("[Threads] Error scraping tag page", { tag, error: String(tagErr) });
        }
      }

      logger.info("[Threads] Scrape completed successfully", { found: results.length });
      return results;
    } catch (err) {
      logger.error("[Threads] Scrape failed", { error: String(err) });
      throw err;
    } finally {
      await browserPage.close();
      await context.close();
    }
  }

  /**
   * Determine whether a post represents an actual job opportunity.
   * If a specific keyword is supplied (e.g. "frontend"), check for it or related skills.
   * If generic or broader query, verify it has job vacancy terminology.
   */
  private isJobOpening(text: string, keyword: string): boolean {
    const lower = text.toLowerCase();
    const kw = keyword.toLowerCase().trim();

    // Exclude posts that are only job seekers asking for jobs
    const isJobSeekerOnly =
      /^(info loker|ada info loker|butuh loker|inpo loker|info lowker)/i.test(text.trim()) &&
      text.length < 80;

    if (isJobSeekerOnly) return false;

    // Check if keyword is matched
    const matchesKeyword =
      ["loker", "job", "lowongan", "kerja"].includes(kw) ||
      lower.includes(kw) ||
      (kw.includes("frontend") && (lower.includes("react") || lower.includes("web") || lower.includes("developer") || lower.includes("programmer") || lower.includes("ui"))) ||
      (kw.includes("backend") && (lower.includes("golang") || lower.includes("api") || lower.includes("node") || lower.includes("laravel") || lower.includes("sql"))) ||
      (kw.includes("it") && (lower.includes("programmer") || lower.includes("developer") || lower.includes("tech") || lower.includes("software")));

    if (!matchesKeyword) return false;

    // Must have at least one vacancy or hiring signal
    const hiringSignals = [
      "hiring", "open recruitment", "dibutuhkan", "posisi", "kualifikasi",
      "persyaratan", "send cv", "kirim cv", "dm us", "apply", "benefit",
      "gaji", "salary", "full time", "part time", "magang", "intern", "staff",
      "needed", "lowongan", "loker",
    ];

    return hiringSignals.some((sig) => lower.includes(sig));
  }

  /**
   * Target the most fruitful hashtags based on keyword.
   */
  private selectTags(keyword: string): string[] {
    const kw = keyword.toLowerCase();
    const tags = ["lowongankerja", "loker", "lokerjakarta"];

    if (kw.includes("remote") || kw.includes("wfh")) {
      tags.unshift("lokerremote");
    }
    if (kw.includes("part time") || kw.includes("parttime")) {
      tags.unshift("lokerparttime");
    }

    return Array.from(new Set(tags));
  }

  /**
   * Parse job title, company, location, and salary from free-form post text.
   */
  private parseJobFromText(text: string, author: string): {
    title: string;
    company: string;
    location: string | null;
    salaryRaw: string | null;
  } {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^\d+$/.test(l));

    // Identify job title line
    let titleLine = lines.find((l) =>
      /(engineer|developer|designer|analyst|manager|staff|officer|intern|programmer|part[\s-]?timer?|full[\s-]?timer?|admin|finance|accounting|barista|cashier|sales|marketing)/i.test(l)
    );

    if (!titleLine) {
      titleLine = lines.find((l) =>
        /^(open|hiring|lowongan|dibutuhkan|needed|dicari)/i.test(l)
      );
    }

    if (!titleLine && lines.length > 1) {
      titleLine = lines[1]; // Often line 0 is author or timestamp
    }

    const title = (titleLine ?? lines[0] ?? "Lowongan Kerja")
      .replace(/^(open recruitment|we are hiring|hiring|lowongan kerja|lowongan|dibutuhkan|needed|dicari)[:\s-]*/i, "")
      .replace(/[#@][\w.]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);

    // Company: Look for "PT", "CV", or company keywords
    const companyMatch = text.match(/(?:PT\.?\s*|CV\.?\s*)([A-Z][A-Za-z0-9\s&]{2,40})/);
    const company = companyMatch
      ? companyMatch[0].replace(/^(PT\.?|CV\.?)\s*/i, "PT ").trim()
      : author || "Info via Threads";

    // Location: common city names
    const locMatch =
      text.match(/(?:lokasi|location|area|domisili)[\s:]+([A-Za-z\s,]{3,30})/i) ??
      text.match(/\b(Jakarta|Bandung|Surabaya|Bali|Yogyakarta|Jogja|Semarang|Medan|Batam|Bekasi|Tangerang|Depok|Bogor|Solo|Tegal|Malang|Remote|WFH)\b/i);
    const location = locMatch ? (locMatch[1] ?? locMatch[0]).trim() : null;

    // Salary: Indonesian currency pattern
    const salMatch = text.match(
      /(Rp\.?\s?[\d.,]+\s?[-–]\s?Rp\.?\s?[\d.,]+|[\d.,]+\s?jt|gaji[\s:]+[\d., Rp]+|salary[\s:]+[\d.,\s\w]+)/i
    );
    const salaryRaw = salMatch ? salMatch[0].trim() : null;

    return { title: title || "Lowongan Kerja", company, location, salaryRaw };
  }
}
