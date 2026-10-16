import { logger } from "./logger.js";

// ─── Playwright availability guard ───────────────────────────────────────────
// Vercel Functions do not ship Chromium. Any attempt to import playwright and
// call chromium.launch() will throw an error at module load time or at runtime.
// We lazy-import playwright so the process can still start and serve /health
// even when no browser binary is present.

type Browser = import("playwright").Browser;
type BrowserContext = import("playwright").BrowserContext;
type Page = import("playwright").Page;

let browser: Browser | null = null;
let playwrightAvailable: boolean | null = null;

async function checkPlaywright(): Promise<boolean> {
  if (playwrightAvailable !== null) return playwrightAvailable;
  try {
    await import("playwright");
    playwrightAvailable = true;
  } catch {
    playwrightAvailable = false;
  }
  return playwrightAvailable;
}

interface BrowserPoolOptions {
  headless?: boolean;
  slowMo?: number;
  timeoutMs?: number;
}

export interface PageOptions {
  timeoutMs?: number;
  blockResources?: boolean;
}

export class BrowserUnavailableError extends Error {
  constructor(message?: string) {
    super(
      message ||
      "Playwright/Chromium is not available in this runtime environment. " +
      "Deploy this service on Railway, Render, or a VPS to enable browser-based scraping."
    );
    this.name = "BrowserUnavailableError";
  }
}

/**
 * Get or create the shared browser instance.
 * Throws BrowserUnavailableError if Playwright is not installed/accessible or binary is missing.
 */
export async function getBrowser(opts: BrowserPoolOptions = {}): Promise<Browser> {
  if (!(await checkPlaywright())) {
    throw new BrowserUnavailableError();
  }

  if (browser && browser.isConnected()) {
    return browser;
  }

  const { chromium } = await import("playwright");
  const headless = opts.headless ?? process.env.SCRAPER_HEADLESS !== "false";
  const slowMo = opts.slowMo ?? Number(process.env.SCRAPER_SLOW_MO ?? 0);

  logger.info("[Browser] Launching Chromium", { headless, slowMo });

  try {
    browser = await chromium.launch({
      headless,
      slowMo,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-extensions",
        "--no-first-run",
        "--disable-default-apps",
        "--disable-infobars",
        "--window-size=1366,768",
        "--lang=id-ID,id",
      ],
    });
  } catch (launchErr: unknown) {
    logger.warn("[Browser] Failed to launch Chromium binary", { error: String(launchErr) });
    throw new BrowserUnavailableError(
      "Chromium browser binary tidak tersedia di environment ini (Vercel Serverless Function). " +
      "Gunakan Railway/Render atau local service untuk scraper berbasis browser."
    );
  }

  browser.on("disconnected", () => {
    logger.warn("[Browser] Browser disconnected, will relaunch on next request");
    browser = null;
  });

  return browser;
}

/**
 * Create an isolated browser context with stealth scripts.
 */
export async function createContext(b: Browser): Promise<BrowserContext> {
  const context = await b.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "id-ID",
    timezoneId: "Asia/Jakarta",
    extraHTTPHeaders: {
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // @ts-expect-error patching chrome
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "plugins", {
      get: () => [{ name: "Chrome PDF Plugin" }, { name: "Chromium PDF Viewer" }],
    });
    Object.defineProperty(navigator, "languages", {
      get: () => ["id-ID", "id", "en-US", "en"],
    });
  });

  return context;
}

/**
 * Create a new page with optional resource blocking.
 */
export async function createPage(context: BrowserContext, opts?: PageOptions): Promise<Page> {
  const page = await context.newPage();
  const timeout = opts?.timeoutMs ?? Number(process.env.SCRAPER_TIMEOUT_MS ?? 30000);
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);

  const shouldBlock = opts?.blockResources ?? true;
  if (shouldBlock) {
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });
  }

  return page;
}

/**
 * Close the global browser instance.
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    logger.info("[Browser] Closing browser");
    await browser.close();
    browser = null;
  }
}

