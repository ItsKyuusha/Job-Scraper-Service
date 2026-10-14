import axios from "axios";
import type { IScraper, ScrapeQuery, JobResult } from "../types/index.js";
import { makeJobResult, parseSalary, parseEmploymentType, parseWorkplaceType, cleanDescription, randomDelay } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

/**
 * Glints Indonesia Scraper
 *
 * Glints exposes a public GraphQL API that we can query directly.
 * This avoids needing a headless browser and is significantly faster.
 *
 * Endpoint: https://glints.com/api/graphql
 */
export class GlintsScraper implements IScraper {
  source = "glints" as const;

  private readonly GRAPHQL_ENDPOINT = "https://glints.com/api/graphql";

  private readonly HEADERS = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Origin": "https://glints.com",
    "Referer": "https://glints.com/id/opportunities/jobs/explore",
    "Accept": "application/json",
    "Accept-Language": "id-ID,id;q=0.9",
  };

  async scrape(query: ScrapeQuery): Promise<JobResult[]> {
    const { keyword, location, page = 1, limit = 20 } = query;
    const offset = (page - 1) * limit;

    // Build search filters for Glints location mapping
    const countryCode = "ID";
    const cityName = this.mapLocation(location ?? "");

    logger.info("[Glints] Starting GraphQL scrape", { keyword, location, page });

    const gqlQuery = {
      operationName: "searchJobsV4",
      variables: {
        data: {
          SearchTerm: keyword,
          CountryCodes: [countryCode],
          LocationNames: cityName ? [cityName] : [],
          first: limit,
          offset,
          includeExternalJobs: true,
        },
      },
      query: `
        query searchJobsV4($data: UnifiedSearchJobsInput!) {
          searchJobsV4(data: $data) {
            jobsInSearch {
              pageInfo { total hasNextPage }
              jobs {
                id title salaryEstimate cityName countryCode
                status isActive createdAt updatedAt
                applicationDeadline
                salaries { salaryType currency minAmount maxAmount }
                WorkArrangementOptions { workArrangementOption }
                isRemote
                jobCategories { name }
                type
                salary
                company { name logo }
                links { url }
                shortDescription
                location { city { name } }
              }
            }
          }
        }
      `,
    };

    try {
      await randomDelay(500, 1500);
      const res = await axios.post(this.GRAPHQL_ENDPOINT, gqlQuery, {
        headers: this.HEADERS,
        timeout: 20000,
      });

      type GlintsJob = Record<string, unknown>;
      type GlintsData = {
        data?: {
          searchJobsV4?: {
            jobsInSearch?: {
              jobs?: GlintsJob[];
            };
          };
        };
        errors?: unknown[];
      };

      const responseData = res.data as GlintsData;

      if (responseData.errors) {
        logger.warn("[Glints] GraphQL returned errors", { errors: responseData.errors });
      }

      const jobs = responseData.data?.searchJobsV4?.jobsInSearch?.jobs ?? [];

      if (jobs.length === 0) {
        logger.warn("[Glints] No jobs returned from GraphQL");
        return [];
      }

      const results = jobs.slice(0, limit).map((job): JobResult => {
        const salaries = (job["salaries"] as Record<string, unknown>[] | null) ?? [];
        const salaryObj = salaries[0] ?? {};
        const salaryMin = Number(salaryObj["minAmount"]) || null;
        const salaryMax = Number(salaryObj["maxAmount"]) || null;
        const currency = String(salaryObj["currency"] ?? "IDR");

        const rawSalary =
          salaryMin && salaryMax
            ? `${currency} ${salaryMin.toLocaleString()} - ${salaryMax.toLocaleString()}`
            : (job["salary"] as string | null);

        const company = job["company"] as Record<string, unknown>;
        const location_ = (job["location"] as Record<string, unknown>) ?? {};
        const city = (location_["city"] as Record<string, unknown>) ?? {};

        const workArr = (job["WorkArrangementOptions"] as Record<string, unknown>[] | null) ?? [];
        const workType = workArr.map((w) => String(w["workArrangementOption"])).join(" ");

        const jobUrl = (job["links"] as Record<string, unknown>[])?.[0]?.["url"] as string | null
          ?? `https://glints.com/id/opportunities/jobs/${job["id"]}`;

        return makeJobResult("glints", {
          title: String(job["title"] ?? ""),
          company: String(company?.["name"] ?? ""),
          location: String(city?.["name"] ?? job["cityName"] ?? location ?? "Indonesia"),
          description: cleanDescription(String(job["shortDescription"] ?? "")),
          employment_type: parseEmploymentType(String(job["type"] ?? "")),
          workplace_type: job["isRemote"] ? "remote" : parseWorkplaceType(workType),
          salary_raw: rawSalary,
          salary_min: salaryMin,
          salary_max: salaryMax,
          currency,
          source_url: jobUrl,
          posted_at: (job["createdAt"] as string | null) ?? null,
        });
      });

      logger.info("[Glints] Scrape completed", { found: results.length });
      return results;
    } catch (err) {
      logger.error("[Glints] Scrape failed", { error: String(err) });
      throw err;
    }
  }

  /** Map generic location strings to Glints city names */
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
