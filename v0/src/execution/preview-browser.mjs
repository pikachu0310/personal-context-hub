import { dirname, join } from "node:path";

export function parsePreviewChecks(value) {
  if (!value?.trim()) return [];
  const checks = JSON.parse(value);
  if (
    !Array.isArray(checks) ||
    checks.length > 10 ||
    checks.some(
      (check) =>
        !check ||
        typeof check.role !== "string" ||
        typeof check.name !== "string" ||
        ![undefined, "click", "fill"].includes(check.action) ||
        (check.action === "fill" && typeof check.value !== "string"),
    )
  )
    throw new Error(
      "Preview checks must be up to 10 named role checks with optional click/fill actions",
    );
  return checks;
}

export function browserPreviewVerifier(
  checks,
  { launch, executablePath } = {},
) {
  return async ({ url, task, signal }) => {
    if (!checks?.length)
      return {
        passed: false,
        summary: "操作条件が未設定です。起動確認のみ行いました。",
      };
    const browser = launch
      ? await launch()
      : await (
          await import("playwright")
        ).chromium.launch({ headless: true, executablePath });
    const bounded = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(30_000),
    ]);
    const abort = () => {
      void browser.close().catch(() => {});
    };
    bounded.addEventListener("abort", abort, { once: true });
    try {
      bounded.throwIfAborted();
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      page.setDefaultTimeout(4000);
      const errors = [];
      page.on("pageerror", () => errors.push("JavaScript実行エラー"));
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
      for (const check of checks) {
        bounded.throwIfAborted();
        const target = page.getByRole(check.role, {
          name: check.name,
          exact: true,
        });
        await target.waitFor({ state: "visible" });
        if (check.minWidth || check.minHeight) {
          const bounds = await target.boundingBox();
          if (
            !bounds ||
            bounds.width < (check.minWidth ?? 0) ||
            bounds.height < (check.minHeight ?? 0)
          )
            throw new Error("操作対象が指定された大きさを満たしません");
        }
        if (check.action === "click") await target.click();
        if (check.action === "fill") await target.fill(check.value);
        if (check.expectText)
          await page
            .getByText(check.expectText, { exact: true })
            .waitFor({ state: "visible" });
      }
      if (errors.length) throw new Error(errors[0]);
      if (task.artifacts?.patchPath) {
        const screenshotPath = join(
          dirname(task.artifacts.patchPath),
          `preview-r${task.runRevision}.png`,
        );
        await page.screenshot({ path: screenshotPath, fullPage: true });
        task.preview.screenshotPath = screenshotPath;
      }
      return {
        passed: true,
        summary: `Chromiumで${checks.length}件の表示・操作条件を確認しました`,
      };
    } finally {
      bounded.removeEventListener("abort", abort);
      await browser.close();
    }
  };
}
