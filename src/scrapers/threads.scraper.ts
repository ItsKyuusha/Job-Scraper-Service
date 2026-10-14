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
 * Threads Job Scraper
 *
 * Scrapes public tags on Threads (`threads.com/tag/{tag}`).
 * Uses comprehensive keyword mapping and permissive filtering to ensure
 * community-shared job vacancies are not dropped.
 */
export class ThreadsScraper implements IScraper {
  source = "threads" as const;

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const rawKeyword = query.keyword;
    const keyword = normalizeKeyword(rawKeyword);
    const { page = 1, limit = 20 } = query;

    const tags = this.selectTags(keyword);
    logger.info("[Threads] Starting tag scrape", { rawKeyword, keyword, tags, page });

    const browser = await getBrowser();
    const context = await createContext(browser);
    const browserPage = await createPage(context, { blockResources: false });

    const results: JobResult[] = [];
    const seenUrls = new Set<string>();

    try {
      for (const tag of tags) {
        if (results.length >= limit) break;

        const url = `https://www.threads.com/tag/${tag}`;
        logger.info("[Threads] Loading tag page", { tag, url });

        try {
          await browserPage.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
          await randomDelay(3000, 4500);

          // Scroll to load dynamic posts
          for (let i = 0; i < Math.min(page + 2, 4); i++) {
            await browserPage.evaluate(() => window.scrollBy(0, 1000));
            await randomDelay(1200, 1800);
          }

          type CandidatePost = {
            postUrl: string;
            author: string;
            text: string;
          };

          const candidates: CandidatePost[] = await browserPage.evaluate(() => {
            const items: { postUrl: string; author: string; text: string }[] = [];
            const seen = new Set<string>();

            // Strategy: query all links that point to posts
            const links = Array.from(document.querySelectorAll('a[href*="/post/"]')) as HTMLAnchorElement[];

            for (const a of links) {
              const href = a.href.split("?")[0];
              if (!href || seen.has(href)) continue;

              // Find closest article or container
              let container: HTMLElement | null = a.parentElement;
              while (
                container &&
                container.innerText &&
                container.innerText.length < 50 &&
                container !== document.body
              ) {
                container = container.parentElement;
              }

              const fullText = (container?.innerText ?? a.innerText ?? "").trim();
              if (fullText.length < 20) continue;

              seen.add(href);

              const authorMatch = href.match(/@([^/]+)/);
              const author = authorMatch ? `@${authorMatch[1]}` : "";

              items.push({ postUrl: href, author, text: fullText });
            }

            return items;
          });

          logger.info("[Threads] Posts found on tag", { tag, count: candidates.length });

          for (const post of candidates) {
            if (results.length >= limit) break;
            if (seenUrls.has(post.postUrl)) continue;

            // Check if post represents a vacancy
            if (!this.isRelevantVacancy(post.text, keyword)) continue;

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
          logger.warn("[Threads] Error loading tag", { tag, error: String(tagErr) });
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
   * More inclusive vacancy filter: accepts any post with hiring / job keywords.
   */
  private isRelevantVacancy(text: string, keyword: string): boolean {
    const lower = text.toLowerCase();
    const kw = keyword.toLowerCase().trim();

    // Skip short inquiries like "ada info loker gak?"
    if (text.length < 60 && /^(ada info loker|info loker dong|butuh loker pls|inpo loker)/i.test(text.trim())) {
      return false;
    }

    // Generic job keywords check
    const hiringSignals = [
      "hiring", "open recruitment", "dibutuhkan", "posisi", "kualifikasi",
      "persyaratan", "send cv", "kirim cv", "dm us", "apply", "benefit",
      "gaji", "salary", "full time", "part time", "magang", "intern", "staff",
      "needed", "lowongan", "loker", "pt ", "cv ", "urgent",
    ];

    const hasHiringSignal = hiringSignals.some((sig) => lower.includes(sig));
    if (!hasHiringSignal) return false;

    // If generic search query, accept
    if (["loker", "job", "lowongan", "kerja"].includes(kw)) {
      return true;
    }

    // Keyword match or skill synonym match
    if (lower.includes(kw)) return true;

    if (kw.includes("frontend")) {
      return ["react", "web", "developer", "programmer", "ui", "vue", "html", "css", "js", "front"].some((s) => lower.includes(s));
    }
    if (kw.includes("backend")) {
      return ["api", "node", "golang", "laravel", "python", "database", "sql", "back"].some((s) => lower.includes(s));
    }
    if (kw.includes("it") || kw.includes("software")) {
      return ["developer", "programmer", "tech", "engineer", "admin", "support"].some((s) => lower.includes(s));
    }

    // Default to including post if it has strong job vacancy structure
    return true;
  }

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

    let titleLine = lines.find((l) =>
      /(engineer|developer|designer|analyst|manager|staff|officer|intern|programmer|part[\s-]?timer?|full[\s-]?timer?|admin|finance|accounting|barista|cashier|sales|marketing|crew|helper)/i.test(l)
    );

    if (!titleLine) {
      titleLine = lines.find((l) =>
        /^(open|hiring|lowongan|dibutuhkan|needed|dicari)/i.test(l)
      );
    }

    if (!titleLine && lines.length > 1) {
      titleLine = lines[1];
    }

    const title = (titleLine ?? lines[0] ?? "Lowongan Kerja")
      .replace(/^(open recruitment|we are hiring|hiring|lowongan kerja|lowongan|dibutuhkan|needed|dicari)[:\s-]*/i, "")
      .replace(/[#@][\w.]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);

    const companyMatch = text.match(/(?:PT\.?\s*|CV\.?\s*)([A-Z][A-Za-z0-9\s&]{2,40})/);
    const company = companyMatch
      ? companyMatch[0].replace(/^(PT\.?|CV\.?)\s*/i, "PT ").trim()
      : author || "Info via Threads";

    const locMatch =
      text.match(/(?:lokasi|location|area|domisili)[\s:]+([A-Za-z\s,]{3,30})/i) ??
      text.match(/\b(Jakarta|Bandung|Surabaya|Bali|Yogyakarta|Jogja|Semarang|Medan|Batam|Bekasi|Tangerang|Depok|Bogor|Solo|Tegal|Malang|Mojokerto|Remote|WFH)\b/i);
    const location = locMatch ? (locMatch[1] ?? locMatch[0]).trim() : null;

    const salMatch = text.match(
      /(Rp\.?\s?[\d.,]+\s?[-–]\s?Rp\.?\s?[\d.,]+|[\d.,]+\s?jt|gaji[\s:]+[\d., Rp]+|salary[\s:]+[\d.,\s\w]+)/i
    );
    const salaryRaw = salMatch ? salMatch[0].trim() : null;

    return { title: title || "Lowongan Kerja", company, location, salaryRaw };
  }
}
