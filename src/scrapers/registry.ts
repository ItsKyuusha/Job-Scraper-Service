import type { IScraper, ScraperSource } from "../types/index.js";
import { LinkedInScraper } from "./linkedin.scraper.js";
import { JobStreetScraper } from "./jobstreet.scraper.js";
import { GlintsScraper } from "./glints.scraper.js";
import { ThreadsScraper } from "./threads.scraper.js";

export const scraperRegistry: Record<ScraperSource, IScraper> = {
  linkedin: new LinkedInScraper(),
  jobstreet: new JobStreetScraper(),
  glints: new GlintsScraper(),
  threads: new ThreadsScraper(),
};
