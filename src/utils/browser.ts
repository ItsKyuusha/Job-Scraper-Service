import { chromium, Browser, BrowserContext, Page } from "playwright";
import { logger } from "./logger.js";

let browser: Browser | null = null;

interface BrowserPoolOptions {
  headless?: boolean;
  slowMo?: number;
  timeoutMs?: number;
}

/**
 * Get or create the shared browser instance.
 * Manual stealth settings embedded directly (replaces playwright-extra-plugin-stealth).
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
      "--disable-web-security",
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
 * Create a new isolated browser context with realistic headers & stealth patches.
 */
export async function createContext(b: Browser): Promise<BrowserContext> {
  const context = await b.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "id-ID",
    timezoneId: "Asia/Jakarta",
    extraHTTPHeaders: {
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  // Stealth: override navigator.webdriver
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
 * Open a new page within a context with reasonable defaults.
 * Blocks heavy resources (images, media, fonts) for speed.
 */
export async function createPage(context: BrowserContext, timeoutMs?: number): Promise<Page> {
  const page = await context.newPage();
  const timeout = timeoutMs ?? Number(process.env.SCRAPER_TIMEOUT_MS ?? 30000);
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);

  await page.route("**/*", (route) => {
    const blocked = ["image", "media", "font", "websocket"];
    if (blocked.includes(route.request().resourceType())) {
      route.abort();
    } else {
      route.continue();
    }
  });

  return page;
}

/**
 * Close the global browser instance gracefully.
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    logger.info("[Browser] Closing browser");
    await browser.close();
    browser = null;
  }
}
