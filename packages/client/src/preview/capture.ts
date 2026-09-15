import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium } from "playwright";
import { previewPath } from "@ido/common/contracts/api";

export function captureOptions(input: Record<string, unknown>) {
  const width = Number(input.width ?? 1280),
    height = Number(input.height ?? 800);
  if (
    !Number.isInteger(width) ||
    width < 320 ||
    width > 2560 ||
    !Number.isInteger(height) ||
    height < 240 ||
    height > 1600
  )
    throw new Error("INVALID_PREVIEW_SIZE");
  return { width, height, path: previewPath(input.path ?? "/") };
}
export async function capturePreview(
  origin: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
) {
  const options = captureOptions(input);
  const browser = await chromium.launch({ headless: true }).catch(() => {
    throw new Error("PREVIEW_BROWSER_REQUIRED");
  });
  const close = () => {
    void browser.close().catch(() => {});
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({
      viewport: { width: options.width, height: options.height },
      serviceWorkers: "block",
    });
    // Never reuse the user's browser profile or allow a page to probe the Client API.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return url.origin === origin ? route.continue() : route.abort();
    });
    await context.routeWebSocket("**/*", (socket) => {
      const url = new URL(socket.url());
      url.protocol = url.protocol === "ws:" ? "http:" : "https:";
      if (url.origin === origin) socket.connectToServer();
      else socket.close();
    });
    const page = await context.newPage();
    await page.goto(origin + options.path, {
      waitUntil: "load",
      timeout: 30_000,
    });
    await page.evaluate(() => document.fonts.ready);
    const bytes = await page.screenshot({
      type: "png",
      animations: "disabled",
      timeout: 15_000,
    });
    signal.throwIfAborted();
    return { bytes, ...options };
  } finally {
    signal.removeEventListener("abort", close);
    await browser.close();
  }
}
let installing: Promise<void> | undefined;
let installer: ChildProcess | undefined;
export async function stopPreviewBrowserInstall() {
  installer?.kill("SIGKILL");
  await installing?.catch(() => {});
}
export function installPreviewBrowser() {
  installing ??= new Promise<void>((resolve, reject) => {
    const require = createRequire(import.meta.url);
    const child = spawn(
      process.execPath,
      [
        join(dirname(require.resolve("playwright/package.json")), "cli.js"),
        "install",
        "chromium",
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        stdio: "ignore",
      },
    );
    installer = child;
    const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("PREVIEW_BROWSER_INSTALL_FAILED"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error("PREVIEW_BROWSER_INSTALL_FAILED"));
    });
  }).finally(() => {
    installing = undefined;
    installer = undefined;
  });
  return installing;
}
