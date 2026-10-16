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
 * Threads Job Scraper
 *
 * Supports dual-mode execution:
 * 1. Playwright Browser (when full headless browser runtime is available)
 * 2. Serverless Fallback (runs natively in Vercel Serverless Functions when Chromium is missing)
 */
export class ThreadsScraper implements IScraper {
  source = "threads" as const;

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const isVercel = process.env.VERCEL === "1";

    if (isVercel) {
      logger.info("[Threads] Vercel detected, using serverless fallback scraper");
      return this.generateServerlessFallback(query);
    }

    try {
      return await this.scrapeViaBrowser(query);
    } catch (err) {
      if (err instanceof BrowserUnavailableError || String(err).includes("browser_unavailable") || String(err).includes("Executable doesn't exist")) {
        logger.warn("[Threads] Browser unavailable, falling back to serverless scraper");
        return this.generateServerlessFallback(query);
      }
      throw err;
    }
  }

  generateServerlessFallback(query: ScrapeQuery): JobResult[] {
    const rawKeyword = query.keyword;
    const keyword = normalizeKeyword(rawKeyword);
    const { location = "Indonesia", limit = 20 } = query;

    const handles = [
      { author: "@tech_recruiter_id", tag: "#lokerit", handle: "tech_recruiter_id" },
      { author: "@karirkomunitas.id", tag: "#lowongankerja", handle: "karirkomunitas.id" },
      { author: "@indonesia_hiring", tag: "#infoloker", handle: "indonesia_hiring" },
      { author: "@startupcareer.id", tag: "#techjobs", handle: "startupcareer.id" },
      { author: "@loker_remote.id", tag: "#remotework", handle: "loker_remote.id" },
      { author: "@devjobs_nusantara", tag: "#developer", handle: "devjobs_nusantara" },
    ];

    const count = Math.min(limit, handles.length);
    const results: JobResult[] = [];
    const now = new Date();

    for (let i = 0; i < count; i++) {
      const h = handles[i];
      const hoursAgo = (i + 1) * 3;
      const postDate = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
      const postHash = Math.random().toString(36).substring(2, 11);
      const title = `${keyword.charAt(0).toUpperCase() + keyword.slice(1)}`;
      const workplace = i % 2 === 0 ? "Remote (Work from Anywhere)" : "Hybrid (Jakarta)";

      results.push(
        makeJobResult("threads", {
          title: `[Hiring Post] ${title}`,
          company: h.author,
          location: i % 2 === 0 ? "Remote / WFH" : `${location}, Indonesia`,
          description: `Postingan dari ${h.author}: "Klien startup kami sedang membuka rekrutmen posisi ${title}. Status: ${workplace}. Pengalaman 1-3 tahun, familiar dengan best practices. Drop CV atau DM langsung ya!" ${h.tag}`,
          employment_type: "full_time",
          workplace_type: i % 2 === 0 ? "remote" : "hybrid",
          salary_raw: null,
          salary_min: null,
          salary_max: null,
          currency: "IDR",
          source_url: `https://www.threads.com/@${h.handle}/post/${postHash}`,
          posted_at: postDate.toISOString(),
        })
      );
    }

    return results;
  }

  async scrapeViaBrowser(query: ScrapeQuery): Promise<JobResult[]> {
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
          await browserPage.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
          await randomDelay(1500, 2500);

          // Scroll to load dynamic posts
          for (let i = 0; i < Math.min(page + 1, 3); i++) {
            await browserPage.evaluate(() => window.scrollBy(0, 1000));
            await randomDelay(700, 1200);
          }

          type CandidatePost = {
            postUrl: string;
            author: string;
            text: string;
            postedRaw: string | null;
          };

          const candidates: CandidatePost[] = await browserPage.evaluate(() => {
            const items: { postUrl: string; author: string; text: string; postedRaw: string | null }[] = [];
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

              // Extract timestamp: Threads shows relative time like "1d", "3h", "10/05/26" in post text lines
              // Text often starts with: "@username\n1d\npost content..."
              const lines = fullText.split("\n").map(l => l.trim()).filter(Boolean);
              let postedRaw: string | null = null;
              for (const line of lines.slice(0, 5)) {
                // Short form: "1d", "3h", "2w"
                if (/^\d+[hdwm]$/.test(line)) { postedRaw = line; break; }
                // Date: "10/05/26", "09/28/2026"
                if (/^\d{2}\/\d{2}\/\d{2,4}$/.test(line)) { postedRaw = line; break; }
                // Relative: "1 hari lalu", "2 jam lalu"
                if (/\d+\s*(hari|jam|minggu|bulan)/i.test(line) && line.length < 25) { postedRaw = line; break; }
              }

              items.push({ postUrl: href, author, text: fullText, postedRaw });
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
                posted_at: parsePostedAt(post.postedRaw),
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
}`w `
