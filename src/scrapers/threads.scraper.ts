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
 * Threads (`threads.com`) public tag pages (`/tag/{hashtag}`) are fully
 * accessible without login, containing live threads with job openings.
 *
 * We scrape relevant Indonesian job tags:
 *   - /tag/loker
 *   - /tag/lokerit (for IT / engineering)
 *   - /tag/lowongankerja
 *   - /tag/lokerjakarta, /tag/lokerremote, etc.
 *
 * Then we filter by the user's requested keyword (e.g. "frontend", "backend")
 * and extract structured job fields using lightweight regex NLP.
 */
export class ThreadsScraper implements IScraper {
  source = "threads" as const;

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const { keyword, page = 1, limit = 20 } = query;

    // Pick target tags based on keyword
    const tags = this.selectTags(keyword);
    logger.info("[Threads] Starting public tag scrape", { keyword, tags, page });

    const browser = await getBrowser();
    const context = await createContext(browser);
    const browserPage = await createPage(context, { blockResources: false });

    const results: JobResult[] = [];
    const seenTexts = new Set<string>();

    try {
      for (const tag of tags) {
        if (results.length >= limit) break;

        const url = `https://www.threads.com/tag/${tag}`;
        logger.info("[Threads] Visiting tag page", { tag, url });

        try {
          await browserPage.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
          await randomDelay(3000, 4500);

          // Scroll to load more dynamically rendered posts
          for (let i = 0; i < Math.min(page, 3); i++) {
            await browserPage.evaluate(() => window.scrollBy(0, 1000));
            await randomDelay(1200, 2000);
          }

          // Extract post elements
          type RawPost = {
            author: string;
            text: string;
            href: string;
          };

          const rawPosts: RawPost[] = await browserPage.evaluate(() => {
            const items: { author: string; text: string; href: string }[] = [];
            
            // Threads posts are typically wrapped in articles or pressable containers
            const containers = Array.from(
              document.querySelectorAll('div[data-pressable-container], article, div[dir="auto"]')
            ) as HTMLElement[];

            containers.forEach((el) => {
              const fullText = el.innerText?.trim() ?? "";
              if (fullText.length < 30) return;

              // Find author link
              const authorLink = el.querySelector('a[href^="https://www.threads.com/@"], a[href^="/@"]') as HTMLAnchorElement | null;
              const author = authorLink ? authorLink.innerText.trim() : "";

              // Find direct link to post
              const postLink = el.querySelector('a[href*="/post/"]') as HTMLAnchorElement | null;
              const href = postLink ? postLink.href : (authorLink ? authorLink.href : "");

              items.push({ author, text: fullText, href });
            });

            return items;
          });

          logger.info("[Threads] Posts found on tag", { tag, count: rawPosts.length });

          for (const post of rawPosts) {
            if (results.length >= limit) break;

            const snippet = post.text.slice(0, 100);
            if (seenTexts.has(snippet)) continue;
            seenTexts.add(snippet);

            // Filter: must look like a job and match keyword if keyword is specific
            if (!this.matchesSearch(post.text, keyword)) continue;

            const parsed = this.parseJobFromText(post.text);
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
                source_url: post.href || url,
                posted_at: null,
              })
            );
          }
        } catch (tagErr) {
          logger.warn("[Threads] Error scraping tag", { tag, error: String(tagErr) });
        }
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

  /**
   * Determine whether a post is relevant to the keyword.
   */
  private matchesSearch(text: string, keyword: string): boolean {
    const lower = text.toLowerCase();
    const kw = keyword.toLowerCase().trim();

    // If generic search like "loker", accept all posts on the loker tag
    if (["loker", "job", "lowongan", "kerja"].includes(kw)) {
      return true;
    }

    // Check keyword presence
    if (lower.includes(kw)) return true;

    // Related technology synonyms
    if (kw.includes("frontend") && (lower.includes("react") || lower.includes("vue") || lower.includes("web developer"))) {
      return true;
    }
    if (kw.includes("backend") && (lower.includes("node") || lower.includes("golang") || lower.includes("laravel") || lower.includes("python"))) {
      return true;
    }

    return false;
  }

  /**
   * Select best hashtag to query based on search intent.
   */
  private selectTags(keyword: string): string[] {
    const kw = keyword.toLowerCase();
    const tags = ["loker"];

    if (kw.includes("frontend") || kw.includes("backend") || kw.includes("it") || kw.includes("engineer") || kw.includes("developer")) {
      tags.unshift("lokerit");
    }
    if (kw.includes("jakarta")) {
      tags.push("lokerjakarta");
    }
    if (kw.includes("remote") || kw.includes("wfh")) {
      tags.push("lokerremote");
    }

    tags.push("lowongankerja");
    return Array.from(new Set(tags)).slice(0, 3);
  }

  /**
   * Extract title, company, location, and salary from free-form social media post.
   */
  private parseJobFromText(text: string): {
    title: string;
    company: string;
    location: string | null;
    salaryRaw: string | null;
  } {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    // Title: first line matching job roles or hiring keywords
    const titleLine =
      lines.find((l) =>
        /(engineer|developer|designer|analyst|manager|staff|officer|intern|programmer|part[\s-]?time|full[\s-]?time|admin|sales|marketing)/i.test(l)
      ) ??
      lines.find((l) =>
        /^(open|hiring|lowongan|dicari|dibutuhkan|we are hiring|info loker)/i.test(l)
      ) ??
      lines[0] ?? "";

    const title = titleLine
      .replace(/^(open|hiring|lowongan|dicari|dibutuhkan|info loker)[:\s]*/i, "")
      .replace(/[#@][\w]+/g, "")
      .trim()
      .slice(0, 100);

    // Company: Look for "PT", "CV", or company mentions
    const companyMatch = text.match(/(?:PT\.?\s*|CV\.?\s*)([A-Z][A-Za-z\s&]{2,35})/);
    const company = companyMatch
      ? companyMatch[0].replace(/^(PT\.?|CV\.?)\s*/i, "PT ").trim()
      : "";

    // Location: popular Indonesian cities
    const locMatch =
      text.match(/(?:lokasi|location|area|domisili)[\s:]+([A-Za-z\s,]{3,30})/i) ??
      text.match(/\b(Jakarta|Bandung|Surabaya|Bali|Yogyakarta|Jogja|Semarang|Medan|Batam|Bekasi|Tangerang|Depok|Bogor|Remote|WFH)\b/i);
    const location = locMatch ? (locMatch[1] ?? locMatch[0]).trim() : null;

    // Salary: Indonesian currency pattern
    const salMatch = text.match(
      /(Rp\.?\s?[\d.,]+\s?[-–]\s?Rp\.?\s?[\d.,]+|[\d.,]+\s?jt|gaji[\s:]+[\d., Rp]+)/i
    );
    const salaryRaw = salMatch ? salMatch[0].trim() : null;

    return { title: title || "Lowongan Kerja", company, location, salaryRaw };
  }
}
