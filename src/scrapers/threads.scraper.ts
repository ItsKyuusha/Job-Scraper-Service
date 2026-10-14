import type { IScraper, ScrapeQuery, JobResult } from "../types/index.js";
import { getBrowser, createContext, createPage } from "../utils/browser.js";
import { makeJobResult, parseEmploymentType, parseWorkplaceType, parseSalary, cleanDescription, randomDelay } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

/**
 * Threads Job Scraper — Multi-Strategy
 *
 * Threads heavily gates content behind login. Strategies tried in order:
 *
 * 1. Threads public profile page for known loker accounts (@lokerindo, etc.)
 * 2. Threads embed/oembed API (no auth needed for some posts)
 * 3. Twitter/X search fallback (more open for job posts hashtag search)
 *
 * Job data is unstructured text, so we use regex NLP to extract fields.
 */
export class ThreadsScraper implements IScraper {
  source = "threads" as const;

  // Well-known Indonesian job posting Threads accounts
  private readonly LOKER_ACCOUNTS = [
    "lokerindo",
    "lowongankerja.id",
    "lokerupdate",
    "infolomba",
  ];

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const { keyword, page = 1, limit = 20 } = query;

    logger.info("[Threads] Starting scrape", { keyword, page });

    // Strategy 1: Scrape known loker accounts on Threads
    const accountResults = await this.scrapeLokerAccounts(keyword, limit);
    if (accountResults.length > 0) {
      return accountResults;
    }

    // Strategy 2: Twitter/X public search (no login required for basic search)
    logger.info("[Threads] Falling back to Twitter/X search");
    const twitterResults = await this.scrapeTwitterSearch(keyword, limit);
    if (twitterResults.length > 0) {
      return twitterResults;
    }

    // Strategy 3: Google search for Threads loker posts (cached)
    logger.info("[Threads] Falling back to Google cached Threads search");
    return this.scrapeViaGoogleThreads(keyword, limit);
  }

  /**
   * Scrape known Indonesian loker Threads accounts.
   * Public profiles on Threads can be loaded without login via mobile URL.
   */
  private async scrapeLokerAccounts(keyword: string, limit: number): Promise<JobResult[]> {
    const results: JobResult[] = [];

    for (const account of this.LOKER_ACCOUNTS) {
      if (results.length >= limit) break;

      const url = `https://www.threads.net/@${account}`;
      const browser = await getBrowser();
      const context = await createContext(browser);
      const browserPage = await createPage(context, 15000);

      try {
        await browserPage.goto(url, { waitUntil: "domcontentloaded" });
        await randomDelay(2500, 4000);

        // Check if we got redirected to login
        const currentUrl = browserPage.url();
        if (currentUrl.includes("login") || currentUrl.includes("accounts")) {
          logger.warn("[Threads] Redirected to login", { account });
          continue;
        }

        // Collect post texts from public account page
        const posts = await browserPage.evaluate(() => {
          const collected: { text: string; href: string }[] = [];
          // Try various selectors for Threads post content
          const postSelectors = [
            "div[data-pressable-container] span",
            "[class*='x193iq5w']",
            "article span",
          ];

          for (const sel of postSelectors) {
            const spans = Array.from(document.querySelectorAll(sel));
            if (spans.length === 0) continue;
            spans.forEach((s) => {
              const text = (s as HTMLElement).innerText?.trim() ?? "";
              if (text.length > 40) {
                const link = s.closest("a");
                collected.push({ text, href: link?.href ?? "" });
              }
            });
            if (collected.length > 0) break;
          }
          return collected;
        }).catch(() => [] as { text: string; href: string }[]);

        logger.debug("[Threads] Posts found on account", { account, count: posts.length });

        for (const { text, href } of posts) {
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
              source_url: href || url,
              posted_at: null,
            })
          );

          if (results.length >= limit) break;
        }
      } catch (err) {
        logger.debug("[Threads] Account scrape failed", { account, error: String(err) });
      } finally {
        await browserPage.close();
        await context.close();
      }
    }

    logger.info("[Threads] Account scrape result", { found: results.length });
    return results;
  }

  /**
   * Twitter/X public search for loker posts (no login for basic search results).
   * Searches for "#loker {keyword}" and extracts job postings.
   */
  private async scrapeTwitterSearch(keyword: string, limit: number): Promise<JobResult[]> {
    const searchQuery = encodeURIComponent(`#loker ${keyword} lang:id`);
    const url = `https://twitter.com/search?q=${searchQuery}&f=live`;

    const browser = await getBrowser();
    const context = await createContext(browser);
    const browserPage = await createPage(context, 20000);

    try {
      await browserPage.goto(url, { waitUntil: "domcontentloaded" });
      await randomDelay(3000, 5000);

      // Check for login wall
      const loginWall = await browserPage.$("[data-testid='loginButton']");
      if (loginWall) {
        logger.warn("[Threads/Twitter] Login wall detected");
        return [];
      }

      // Collect tweets
      const tweets = await browserPage.evaluate(() => {
        const tweetEls = Array.from(document.querySelectorAll("[data-testid='tweetText']"));
        return tweetEls.slice(0, 40).map((el) => {
          const text = (el as HTMLElement).innerText?.trim() ?? "";
          const article = el.closest("article");
          const timeLink = article?.querySelector("time")?.closest("a") as HTMLAnchorElement | null;
          return { text, url: timeLink?.href ?? "" };
        });
      }).catch(() => [] as { text: string; url: string }[]);

      logger.info("[Threads/Twitter] Found tweets", { count: tweets.length });

      const results: JobResult[] = [];
      for (const { text, url: tweetUrl } of tweets) {
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
            source_url: tweetUrl || url,
            posted_at: null,
          })
        );
        if (results.length >= limit) break;
      }

      return results;
    } catch (err) {
      logger.error("[Threads/Twitter] Search failed", { error: String(err) });
      return [];
    } finally {
      await browserPage.close();
      await context.close();
    }
  }

  /**
   * Google search for Threads loker posts as last fallback.
   * site:threads.net searches show public posts in results.
   */
  private async scrapeViaGoogleThreads(keyword: string, limit: number): Promise<JobResult[]> {
    const q = encodeURIComponent(`site:threads.net loker ${keyword}`);
    const url = `https://www.google.com/search?q=${q}&num=20&hl=id`;

    const browser = await getBrowser();
    const context = await createContext(browser);
    const browserPage = await createPage(context, 15000);

    try {
      await browserPage.goto(url, { waitUntil: "domcontentloaded" });
      await randomDelay(1500, 2500);

      const items = await browserPage.evaluate(() => {
        const results: { title: string; snippet: string; url: string }[] = [];
        const divs = Array.from(document.querySelectorAll("div.g"));
        divs.slice(0, 20).forEach((div) => {
          const titleEl = div.querySelector("h3");
          const snippetEl = div.querySelector("[data-sncf='1'], .VwiC3b, [data-snhf='0']");
          const linkEl = div.querySelector("a[href]") as HTMLAnchorElement | null;
          const title = titleEl?.textContent?.trim() ?? "";
          const snippet = snippetEl?.textContent?.trim() ?? "";
          const href = linkEl?.href ?? "";
          if (title && href.includes("threads.net")) {
            results.push({ title, snippet, url: href });
          }
        });
        return results;
      }).catch(() => [] as { title: string; snippet: string; url: string }[]);

      logger.info("[Threads/Google] Found Threads results", { count: items.length });

      return items.slice(0, limit).map((item) => {
        const parsed = this.parseJobFromText(item.snippet || item.title);
        return makeJobResult("threads", {
          title: parsed.title || item.title.replace(/threads\.net\s*[·-]/gi, "").trim(),
          company: parsed.company,
          location: parsed.location,
          description: cleanDescription(item.snippet),
          employment_type: parseEmploymentType(item.snippet),
          workplace_type: parseWorkplaceType(item.snippet),
          salary_raw: parsed.salaryRaw,
          ...parseSalary(parsed.salaryRaw),
          source_url: item.url,
          posted_at: null,
        });
      }).filter((r) => r.title.length > 3);
    } catch (err) {
      logger.error("[Threads/Google] Fallback failed", { error: String(err) });
      return [];
    } finally {
      await browserPage.close();
      await context.close();
    }
  }

  private looksLikeJobPost(text: string, keyword: string): boolean {
    const lower = text.toLowerCase();
    const jobSignals = [
      "loker", "lowongan", "hiring", "dicari", "dibutuhkan",
      "open position", "join us", "kualifikasi", "apply", "kirim cv", "lamaran",
    ];
    const hasJobSignal = jobSignals.some((s) => lower.includes(s));
    const hasKeyword = lower.includes(keyword.toLowerCase());
    return hasJobSignal && (hasKeyword || lower.includes("engineer") || lower.includes("developer") || lower.includes("staff"));
  }

  private parseJobFromText(text: string): {
    title: string;
    company: string;
    location: string | null;
    salaryRaw: string | null;
  } {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    const titleLine =
      lines.find((l) => l.match(/(engineer|developer|designer|analyst|manager|staff|officer|intern|programmer|akuntan|marketing|sales|admin)/i)) ??
      lines.find((l) => l.match(/^(open|hiring|lowongan|dicari|dibutuhkan)/i)) ??
      lines[0] ?? "";

    const title = titleLine.replace(/^(open|hiring|lowongan|dicari):?\s*/i, "").trim().slice(0, 120);

    const companyMatch = text.match(/(?:PT\.?\s*|CV\.?\s*)([A-Z][A-Za-z\s&]{2,40})(?:\.|,|$|\n)/);
    const company = companyMatch ? companyMatch[0].replace(/^(PT\.?|CV\.?)\s*/i, "PT ").trim() : "Tidak Diketahui";

    const locationMatch =
      text.match(/(?:lokasi|location|wilayah|area|domisili)[\s:]+([A-Za-z\s,]{3,40})/i) ??
      text.match(/\b(Jakarta|Bandung|Surabaya|Bali|Yogyakarta|Semarang|Medan|Bekasi|Tangerang|Depok|Bogor|Remote|WFH)\b/i);
    const location = locationMatch ? (locationMatch[1] ?? locationMatch[0]).trim() : null;

    const salaryMatch = text.match(/(Rp\.?\s?[\d.,][\d.,\s]*[-–]\s?Rp\.?\s?[\d.,]+|[\d]+\s?[Jj]t[a-z]*|gaji[\s:]+[\d., Rp]+)/i);
    const salaryRaw = salaryMatch ? salaryMatch[0].trim() : null;

    return { title, company, location, salaryRaw };
  }
}
