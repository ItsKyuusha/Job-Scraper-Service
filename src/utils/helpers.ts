import { v4 as uuidv4 } from "uuid";
import type { JobResult, EmploymentType, WorkplaceType, ScraperSource } from "../types/index.js";

/**
 * Generate a new UUID for a scraped job result.
 */
export function newJobId(): string {
  return uuidv4();
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
 * Sleep for a given number of milliseconds (human-like delay).
 */
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
