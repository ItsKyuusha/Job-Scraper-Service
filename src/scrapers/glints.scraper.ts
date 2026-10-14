import type { IScraper, ScrapeQuery, JobResult } from "../types/index.js";
import { getBrowser, createContext, createPage } from "../utils/browser.js";
import { makeJobResult, parseEmploymentType, parseWorkplaceType, cleanDescription, randomDelay } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

/**
 * Glints Indonesia Scraper — Playwright + Network Intercept
 *
 * Glints blocks direct Axios requests (403). Strategy:
 * 1. Open Glints job search page with Playwright (real browser session)
 * 2. Intercept the outgoing GraphQL API call that Glints makes internally
 * 3. Capture the JSON response from that network request
 * 4. Parse and return structured JobResult[]
 *
 * This avoids the 403 because the request originates from a real browser
 * with proper cookies, Referer, and Origin headers set automatically.
 */
export class GlintsScraper implements IScraper {
  source = "glints" as const;

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const { keyword, location, page = 1, limit = 20 } = query;
    const cityName = this.mapLocation(location ?? "");
    const offset = (page - 1) * limit;

    const searchUrl =
      `https://glints.com/id/opportunities/jobs/explore` +
      `?keyword=${encodeURIComponent(keyword)}` +
      (cityName ? `&locationName=${encodeURIComponent(cityName)}` : "");

    logger.info("[Glints] Starting Playwright intercept scrape", { keyword, location, page });

    const browser = await getBrowser();
    const context = await createContext(browser);
    const browserPage = await createPage(context);

    // Collected GraphQL response data
    type GlintsJob = Record<string, unknown>;
    let interceptedJobs: GlintsJob[] = [];

    // Set up network intercept BEFORE navigation
    browserPage.on("response", async (response) => {
      const url = response.url();
      if (!url.includes("glints.com/api/graphql")) return;
      if (response.status() !== 200) return;

      try {
        const json = await response.json() as Record<string, unknown>;
        const jobs =
          (json?.data as Record<string, unknown>)
            ?.searchJobsV4 as Record<string, unknown> | undefined;
        const jobList = (jobs?.jobsInSearch as Record<string, unknown>)?.jobs as GlintsJob[] | undefined;
        if (Array.isArray(jobList) && jobList.length > 0) {
          interceptedJobs = [...interceptedJobs, ...jobList];
          logger.debug("[Glints] Intercepted GraphQL response", { count: jobList.length });
        }
      } catch {
        // Non-JSON response, ignore
      }
    });

    try {
      await browserPage.goto(searchUrl, { waitUntil: "domcontentloaded" });
      await randomDelay(2000, 3500);

      // Wait for job cards to appear — triggers the internal GraphQL call
      await browserPage
        .waitForSelector("[data-cy='job-card-with-track']", { timeout: 15000 })
        .catch(() =>
          browserPage.waitForSelector("[class*='JobCardStyles']", { timeout: 5000 }).catch(() => null)
        );

      // Give extra time for all network requests to settle
      await randomDelay(1500, 2500);

      // If intercept got data, use it
      if (interceptedJobs.length > 0) {
        logger.info("[Glints] Using intercepted GraphQL data", { total: interceptedJobs.length });
        return this.parseJobList(interceptedJobs.slice(offset, offset + limit), location ?? "Indonesia");
      }

      // Fallback: parse DOM directly
      logger.warn("[Glints] GraphQL intercept got no data, falling back to DOM parse");
      return await this.parseFromDom(browserPage, limit, location ?? "Indonesia", keyword);
    } catch (err) {
      logger.error("[Glints] Scrape failed", { error: String(err) });
      throw err;
    } finally {
      await browserPage.close();
      await context.close();
    }
  }

  private parseJobList(jobs: Record<string, unknown>[], fallbackLocation: string): JobResult[] {
    return jobs.map((job) => {
      const salaries = (job["salaries"] as Record<string, unknown>[] | null) ?? [];
      const salaryObj = salaries[0] ?? {};
      const salaryMin = Number(salaryObj["minAmount"]) || null;
      const salaryMax = Number(salaryObj["maxAmount"]) || null;
      const currency = String(salaryObj["currency"] ?? "IDR");

      const rawSalary =
        salaryMin && salaryMax
          ? `${currency} ${salaryMin.toLocaleString()} - ${salaryMax.toLocaleString()}`
          : null;

      const company = job["company"] as Record<string, unknown>;
      const locationObj = (job["location"] as Record<string, unknown>) ?? {};
      const city = (locationObj["city"] as Record<string, unknown>) ?? {};
      const workArr = (job["WorkArrangementOptions"] as Record<string, unknown>[] | null) ?? [];
      const workType = workArr.map((w) => String(w["workArrangementOption"])).join(" ");
      const jobId = String(job["id"] ?? "");

      return makeJobResult("glints", {
        title: String(job["title"] ?? ""),
        company: String(company?.["name"] ?? ""),
        location: String(city?.["name"] ?? job["cityName"] ?? fallbackLocation),
        description: cleanDescription(String(job["shortDescription"] ?? "")),
        employment_type: parseEmploymentType(String(job["type"] ?? "")),
        workplace_type: job["isRemote"] ? "remote" : parseWorkplaceType(workType),
        salary_raw: rawSalary,
        salary_min: salaryMin,
        salary_max: salaryMax,
        currency,
        source_url: `https://glints.com/id/opportunities/jobs/${jobId}`,
        posted_at: (job["createdAt"] as string | null) ?? null,
      });
    });
  }

  private async parseFromDom(
    page: import("playwright").Page,
    limit: number,
    fallbackLocation: string,
    keyword: string
  ): Promise<JobResult[]> {
    // Scrape job cards from rendered DOM as last resort
    const cards = await page.$$eval(
      "[data-cy='job-card-with-track'], [class*='JobCardStyles__JobcardWrapper']",
      (els) =>
        els.slice(0, 30).map((el) => ({
          title: el.querySelector("[data-cy='job-card-title']")?.textContent?.trim() ?? "",
          company: el.querySelector("[data-cy='job-card-company-name']")?.textContent?.trim() ?? "",
          location: el.querySelector("[data-cy='job-card-location']")?.textContent?.trim() ?? "",
          salary: el.querySelector("[data-cy='job-card-salary']")?.textContent?.trim() ?? "",
          url: (el.querySelector("a[href*='/opportunities/jobs/']") as HTMLAnchorElement)?.href ?? "",
          type: el.querySelector("[data-cy='job-card-type']")?.textContent?.trim() ?? "",
        }))
    ).catch(() => [] as { title: string; company: string; location: string; salary: string; url: string; type: string }[]);

    return cards
      .filter((c) => c.title && c.company)
      .slice(0, limit)
      .map((c) =>
        makeJobResult("glints", {
          title: c.title,
          company: c.company,
          location: c.location || fallbackLocation,
          description: null,
          employment_type: parseEmploymentType(c.type),
          workplace_type: parseWorkplaceType(c.location + " " + c.type),
          salary_raw: c.salary || null,
          salary_min: null,
          salary_max: null,
          source_url: c.url || `https://glints.com/id/opportunities/jobs/explore?keyword=${encodeURIComponent(keyword)}`,
          posted_at: null,
        })
      );
  }

  private mapLocation(location: string): string {
    const lower = location.toLowerCase();
    const map: Record<string, string> = {
      jakarta: "Jakarta", bandung: "Bandung", surabaya: "Surabaya",
      yogyakarta: "Yogyakarta", bali: "Bali", medan: "Medan",
      semarang: "Semarang", remote: "", indonesia: "",
    };
    for (const [key, val] of Object.entries(map)) {
      if (lower.includes(key)) return val;
    }
    return location;
  }
}
