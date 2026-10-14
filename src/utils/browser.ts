import { chromium, Browser, BrowserContext, Page } from "playwright";
import { logger } from "./logger.js";

let browser: Browser | null = null;

interface BrowserPoolOptions {
  headless?: boolean;
  slowMo?: number;
  timeoutMs?: number;
}

export interface PageOptions {
  timeoutMs?: number;
  blockResources?: boolean;
}

/**
 * Get or create the shared browser instance.
 * Chromium configured with stealth arguments.
 */
export async function getBrowser(opts: BrowserPoolOptions = {}): Promise<Browser> {
  if (browser && browser.isConnected()) {
    return browser;
  }

  const headless = opts.headless ?? process.env.SCRAPER_HEADLESS !== "false";
  const slowMo = opts.slowMo ?? Number(process.env.SCRAPER_SLOW_MO ?? 0);

  logger.info("[Browser] Launching Chromium", { headless, slowMo });

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
 * Create a new page.
 * Note: By default, `blockResources` is false because modern SPAs (JobStreet, Glints)
 * depend on fonts / scripts / websockets for fingerprint verification.
 */
export async function createPage(context: BrowserContext, opts?: PageOptions): Promise<Page> {
  const page = await context.newPage();
  const timeout = opts?.timeoutMs ?? Number(process.env.SCRAPER_TIMEOUT_MS ?? 30000);
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);

  if (opts?.blockResources) {
    await page.route("**/*", (route) => {
      const blocked = ["image", "media"];
      if (blocked.includes(route.request().resourceType())) {
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
