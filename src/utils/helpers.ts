import { v4 as uuidv4 } from "uuid";
import type { JobResult, EmploymentType, WorkplaceType, ScraperSource } from "../types/index.js";

/**
 * Generate a new UUID for a scraped job result.
 */
export function newJobId(): string {
  return uuidv4();
}

/**
 * Normalize and space compound keywords often typed without spaces.
 * E.g.: "systemanalyst" -> "system analyst", "frontenddeveloper" -> "frontend developer",
 * "projectmanager" -> "project manager", "dataanalyst" -> "data analyst".
 */
export function normalizeKeyword(raw: string): string {
  let kw = raw.trim();
  if (!kw) return "";

  // Common compound job terms mapping
  const compoundMap: Record<string, string> = {
    systemanalyst: "system analyst",
    systemsanalyst: "systems analyst",
    businessanalyst: "business analyst",
    dataanalyst: "data analyst",
    datascience: "data science",
    datascientist: "data scientist",
    frontenddeveloper: "frontend developer",
    backenddeveloper: "backend developer",
    fullstackdeveloper: "fullstack developer",
    softwareengineer: "software engineer",
    softwaredirector: "software director",
    softwaredeveloper: "software developer",
    productmanager: "product manager",
    projectmanager: "project manager",
    scrummaster: "scrum master",
    devopsengineer: "devops engineer",
    qaengineer: "qa engineer",
    qualityassurance: "quality assurance",
    uidesigner: "ui designer",
    uxdesigner: "ux designer",
    uiux: "ui ux",
    uiuxdesigner: "ui ux designer",
    webdeveloper: "web developer",
    mobiledeveloper: "mobile developer",
    networkengineer: "network engineer",
    securityanalyst: "security analyst",
    cybersecurity: "cyber security",
    itstaff: "it staff",
    itsupport: "it support",
  };

  const lower = kw.toLowerCase().replace(/[-_]+/g, "");
  if (compoundMap[lower]) {
    return compoundMap[lower];
  }

  // Split CamelCase if present (e.g. SystemAnalyst -> System Analyst)
  kw = kw.replace(/([a-z])([A-Z])/g, "$1 $2");

  return kw;
}

/**
 * Normalize raw salary string into min/max numeric values (IDR).
 * Handles formats like:
 *   "Rp 8.000.000 - Rp 12.000.000"
 *   "8000000 - 12000000"
 *   "IDR 8 Jt - 12 Jt"
 *   "8 juta - 12 juta"
 */
export function parseSalary(raw: string | null): {
  salary_min: number | null;
  salary_max: number | null;
  currency: string;
} {
  if (!raw || raw.trim().length === 0) {
    return { salary_min: null, salary_max: null, currency: "IDR" };
  }

  const currency = raw.includes("USD") ? "USD" : "IDR";

  // Remove currency symbols and normalize
  const cleaned = raw
    .replace(/Rp\.?|IDR|USD|\$/gi, "")
    .replace(/juta|jt/gi, "000000")
    .replace(/ribu|rb/gi, "000")
    .replace(/[^\d,.\-–]/g, " ")
    .replace(/\./g, "")
    .replace(/,/g, ".")
    .trim();

  const parts = cleaned
    .split(/[-–]/)
    .map((p) => p.trim())
    .map((p) => parseFloat(p.replace(/\s/g, "")))
    .filter((n) => !isNaN(n) && n > 0);

  if (parts.length === 0) return { salary_min: null, salary_max: null, currency };
  if (parts.length === 1) return { salary_min: parts[0], salary_max: parts[0], currency };
  return { salary_min: Math.min(...parts), salary_max: Math.max(...parts), currency };
}

/**
 * Parse raw employment type string into typed enum value.
 */
export function parseEmploymentType(raw: string | null | undefined): EmploymentType {
  if (!raw) return "unknown";
  const lower = raw.toLowerCase();
  if (lower.includes("full") || lower.includes("penuh")) return "full_time";
  if (lower.includes("part") || lower.includes("paruh")) return "part_time";
  if (lower.includes("contract") || lower.includes("kontrak")) return "contract";
  if (lower.includes("freelance") || lower.includes("lepas")) return "freelance";
  if (lower.includes("intern") || lower.includes("magang")) return "internship";
  return "unknown";
}

/**
 * Parse raw workplace type string into typed enum value.
 */
export function parseWorkplaceType(raw: string | null | undefined): WorkplaceType {
  if (!raw) return "unknown";
  const lower = raw.toLowerCase();
  if (lower.includes("remote") || lower.includes("jarak jauh")) return "remote";
  if (lower.includes("hybrid") || lower.includes("hibrid")) return "hybrid";
  if (lower.includes("onsite") || lower.includes("on-site") || lower.includes("kantor")) return "onsite";
  return "unknown";
}

/**
 * Clean and truncate HTML description to plain text.
 */
export function cleanDescription(raw: string | null): string | null {
  if (!raw) return null;
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000) || null;
}

/**
 * Create a minimal JobResult shell with required defaults.
 * Note: `source` field is handled by the 2nd arg overwrite so
 * we exclude it from the Omit to avoid duplicate-property issues.
 */
export function makeJobResult(
  source: ScraperSource,
  partial: Omit<JobResult, "id" | "scraped_at" | "source" | "currency"> & { currency?: string }
): JobResult {
  return {
    id: newJobId(),
    scraped_at: new Date().toISOString(),
    currency: "IDR",
    ...partial,
    source,
  };
}

/**
 * Parse and normalize various raw date/time strings into ISO 8601.
 *
 * Handles:
 *   ISO datetime    : "2026-09-18T00:00:00.000Z"     → kept as-is
 *   Date only       : "2026-09-18"                   → "2026-09-18T00:00:00.000Z"
 *   Relative (EN)   : "1 day ago", "3 hours ago", "2 weeks ago"
 *   Relative (ID)   : "1 hari yang lalu", "3 jam", "2 minggu lalu"
 *   Relative short  : "1d", "3h", "2w", "5d"
 *   Threads style   : "1d", "10/05/26", "09/28/2026"
 *   JobStreet style : "Listed 1 day ago", "Listed 5 days ago", "13 hari yang lalu"
 *
 * Returns ISO string or null if cannot be parsed.
 */
export function parsePostedAt(raw: string | null | undefined): string | null {
  if (!raw || raw.trim().length === 0) return null;

  const s = raw.trim();
  const now = new Date();

  // Already ISO-ish (YYYY-MM-DD or full ISO)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // MM/DD/YY or MM/DD/YYYY (Threads style like "10/05/26" or "09/28/2026")
  if (/^\d{2}\/\d{2}\/\d{2,4}$/.test(s)) {
    const parts = s.split("/");
    const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
    const d = new Date(`${year}-${parts[0]}-${parts[1]}`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // Clean prefix noise e.g. "Listed more than one day ago" → "one day ago"
  const cleaned = s
    .replace(/^listed\s+(more\s+than\s+)?/i, "")
    .replace(/^posted\s+/i, "")
    .trim();

  // Short form: "1d", "3h", "2w", "4m" (months) or "1d ago"
  const shortMatch = cleaned.match(/^(\d+)\s*([hdwm])(?:\s*ago)?$/i);
  if (shortMatch) {
    const n = parseInt(shortMatch[1]);
    const unit = shortMatch[2].toLowerCase();
    const d = new Date(now);
    if (unit === "h") d.setHours(d.getHours() - n);
    else if (unit === "d") d.setDate(d.getDate() - n);
    else if (unit === "w") d.setDate(d.getDate() - n * 7);
    else if (unit === "m") d.setMonth(d.getMonth() - n);
    return d.toISOString();
  }

  // Handle words like "one day ago", "two days ago"
  const wordMap: Record<string, number> = {
    one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5,
  };
  const wordMatch = cleaned.match(
    /(one|two|three|four|five|six|seven|eight|nine|ten|satu|dua|tiga|empat|lima)\s*(hour|hours?|jam|day|days?|hari|week|weeks?|minggu|month|months?|bulan)\s*(ago|lalu|yang\s+lalu)?/i
  );
  if (wordMatch) {
    const n = wordMap[wordMatch[1].toLowerCase()] ?? 1;
    const unit = wordMatch[2].toLowerCase();
    const d = new Date(now);
    if (["hour", "hours", "jam"].some((u) => unit.startsWith(u))) {
      d.setHours(d.getHours() - n);
    } else if (["day", "days", "hari"].some((u) => unit.startsWith(u))) {
      d.setDate(d.getDate() - n);
    } else if (["week", "weeks", "minggu"].some((u) => unit.startsWith(u))) {
      d.setDate(d.getDate() - n * 7);
    } else if (["month", "months", "bulan"].some((u) => unit.startsWith(u))) {
      d.setMonth(d.getMonth() - n);
    }
    return d.toISOString();
  }

  // Pattern: N unit ago (EN/ID)
  // "1 day ago", "3 days ago", "2 hours ago", "1 week ago"
  // "1 hari yang lalu", "3 hari lalu", "2 jam lalu", "1 minggu"
  const relMatch = cleaned.match(
    /(\d+)\s*(hour|hours?|jam|day|days?|hari|week|weeks?|minggu|month|months?|bulan)\s*(ago|lalu|yang\s+lalu)?/i
  );
  if (relMatch) {
    const n = parseInt(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const d = new Date(now);
    if (["hour", "hours", "jam"].some((u) => unit.startsWith(u))) {
      d.setHours(d.getHours() - n);
    } else if (["day", "days", "hari"].some((u) => unit.startsWith(u))) {
      d.setDate(d.getDate() - n);
    } else if (["week", "weeks", "minggu"].some((u) => unit.startsWith(u))) {
      d.setDate(d.getDate() - n * 7);
    } else if (["month", "months", "bulan"].some((u) => unit.startsWith(u))) {
      d.setMonth(d.getMonth() - n);
    }
    return d.toISOString();
  }

  // "Just now" / "baru saja"
  if (/^just now|^baru saja/i.test(cleaned)) {
    return now.toISOString();
  }

  return null;
}

/**
 * Format ISO date string to a human-readable label.
 * Returns e.g. "2 hari lalu", "Hari ini", "5 jam lalu"
 */
export function formatPostedAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;

  const diffMs = Date.now() - d.getTime();
  const diffH = Math.floor(diffMs / (1000 * 60 * 60));
  const diffD = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffH < 1) return "Baru saja";
  if (diffH < 24) return `${diffH} jam lalu`;
  if (diffD === 1) return "Kemarin";
  if (diffD < 7) return `${diffD} hari lalu`;
  if (diffD < 14) return "1 minggu lalu";
  if (diffD < 30) return `${Math.floor(diffD / 7)} minggu lalu`;
  if (diffD < 60) return "1 bulan lalu";
  return `${Math.floor(diffD / 30)} bulan lalu`;
}

/**
 * Deduplicate an array of JobResult items.
 *
 * Rules:
 * 1. Primary deduplication key: canonical clean source_url
 * 2. Secondary deduplication key: normalized title + normalized company (same position in same company)
 * 3. When duplicates are found, keep the one with the most complete information:
 *    - Has salary / higher salary info
 *    - Has description
 *    - Has posted_at timestamp
 *    - Latest scraped_at
 */
export function deduplicateJobs(jobs: JobResult[]): JobResult[] {
  function getScore(job: JobResult): number {
    let score = 0;
    if (job.description && job.description.length > 30) score += 4;
    if (job.salary_raw || job.salary_min) score += 3;
    if (job.posted_at) score += 2;
    if (job.location && job.location !== "Indonesia") score += 1;
    if (job.employment_type && job.employment_type !== "unknown") score += 1;
    if (job.workplace_type && job.workplace_type !== "unknown") score += 1;
    return score;
  }

  function cleanUrl(rawUrl: string): string {
    try {
      const u = new URL(rawUrl);
      // Strip common tracking query params
      u.searchParams.delete("refId");
      u.searchParams.delete("trackingId");
      u.searchParams.delete("position");
      u.searchParams.delete("pageNum");
      u.searchParams.delete("utm_source");
      u.searchParams.delete("utm_medium");
      u.searchParams.delete("utm_campaign");
      u.searchParams.delete("utm_referrer");
      u.searchParams.delete("traceInfo");
      return u.origin + u.pathname;
    } catch {
      return rawUrl.split("?")[0].toLowerCase().trim();
    }
  }

  function makeTitleKey(title: string, company: string): string {
    const t = title.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
    const c = company.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
    return `${t}@@${c}`;
  }

  const resultMap = new Map<string, JobResult>();
  const titleKeyToUrlKey = new Map<string, string>();

  for (const job of jobs) {
    const urlKey = cleanUrl(job.source_url);
    const titleKey = makeTitleKey(job.title, job.company);

    // Check if we already have this job by url or title+company
    const existingUrlKey = titleKeyToUrlKey.get(titleKey) || urlKey;
    const existing = resultMap.get(existingUrlKey);

    if (!existing) {
      resultMap.set(urlKey, job);
      if (titleKey.length > 5) {
        titleKeyToUrlKey.set(titleKey, urlKey);
      }
    } else {
      // Duplicate found! Keep the one with the higher completeness score
      const existingScore = getScore(existing);
      const newScore = getScore(job);

      if (newScore > existingScore) {
        resultMap.delete(existingUrlKey);
        resultMap.set(urlKey, job);
        titleKeyToUrlKey.set(titleKey, urlKey);
      }
    }
  }

  return Array.from(resultMap.values());
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Random delay between min and max ms to avoid detection.
 */
export function randomDelay(min = 800, max = 2500): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(ms);
}
