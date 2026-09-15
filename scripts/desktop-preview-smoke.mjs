import assert from "node:assert/strict";
import { build } from "esbuild";
import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  previewFixture,
  until,
} from "../packages/client/test/preview-fixture.ts";

const f = await previewFixture();
let app, captureBrowser;
try {
  const manager = f.client.localPreviews;
  const views = await manager.prepare(
    { projectId: "p", implementationIds: ["a", "b"] },
    "desktop-fixture",
  );
  await until(() =>
    manager.list("desktop-fixture").every((v) => v.state === "prepared"),
  );
  await Promise.all(views.map((v) => manager.start(v.id, "desktop-fixture")));
  await until(() =>
    manager.list("desktop-fixture").every((v) => v.state === "running"),
  );
  const registered = manager.list("desktop-fixture").map((v) => v.url);
  const entry = join(f.directory, "desktop.cjs");
  await build({
    stdin: {
      contents: `
      const { app, BrowserWindow } = require('electron');
      const { previewRequestAllowed } = require(${JSON.stringify(resolve("packages/desktop/src/security.ts"))});
      const origin = ${JSON.stringify(f.client.origin)};
      const origins = ${JSON.stringify(registered)};
      const registered = (value) => { try { return origins.includes(new URL(value.replace(/^ws:/,'http:')).origin); } catch { return false; } };
      app.whenReady().then(() => {
        const window = new BrowserWindow({ width: 1500, height: 1050, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
        window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
        window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !previewRequestAllowed(details.url, details.frame?.url ?? '', details.resourceType, origin, registered) }));
        window.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
        window.loadURL(origin);
      });
      app.on('window-all-closed', () => app.quit());
    `,
      resolveDir: process.cwd(),
    },
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    logLevel: "silent",
  });
  const request = f.client.workspaceRequest;
  f.client.workspaceRequest = async (operation, input) =>
    operation === "project.snapshot"
      ? {
          project: f.client.settings.projects[0],
          tasks: [],
          participants: [],
          canEditMinutes: false,
          minutes: [
            {
              id: "m",
              projectId: "p",
              name: "比較",
              messages: [],
              summary: "[2案を比較](ido://projects/p/compare/a/b)",
            },
          ],
        }
      : request(operation, input);
  const require = createRequire(import.meta.url);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: require("electron"),
    args: [entry, `--user-data-dir=${join(f.directory, "desktop-profile")}`],
    env,
  });
  const page = await app.firstWindow();
  await page
    .locator('.project-group[data-project-id="p"]')
    .getByRole("button", { name: "議事録", exact: true })
    .click();
  await page.locator(".minutes-list-row").click();
  await page.getByRole("link", { name: "2案を比較" }).click();
  await page
    .frameLocator(".preview-pane iframe")
    .first()
    .getByRole("button", { name: "試す" })
    .click();
  await page
    .frameLocator(".preview-pane iframe")
    .first()
    .getByRole("button", { name: "操作できました" })
    .waitFor();
  await page
    .frameLocator(".preview-pane iframe")
    .nth(1)
    .getByRole("button", { name: "試す" })
    .waitFor();
  assert.equal(
    await page.evaluate(() => typeof globalThis.require),
    "undefined",
  );
  const frame = page
    .frames()
    .find((frame) => frame.url().startsWith(registered[0]));
  assert.equal(
    await frame.evaluate(
      (url) =>
        fetch(url + "/api/state").then(
          () => true,
          () => false,
        ),
      f.client.origin,
    ),
    false,
  );
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({ path: ".ido-build/screenshots/preview-desktop.png" });
  // Resolve from the staged distribution, not the workspace's development dependency.
  const staged = createRequire(resolve(".ido-build/desktop/app/package.json"));
  assert.ok(
    staged
      .resolve("playwright")
      .startsWith(resolve(".ido-build/desktop/app/node_modules")),
  );
  captureBrowser = await staged("playwright").chromium.launch({
    headless: true,
  });
  const capture = await captureBrowser.newPage({
    viewport: { width: 640, height: 480 },
  });
  await capture.goto(registered[0]);
  assert.ok((await capture.screenshot()).length > 1000);
  console.log(
    "Desktop preview smoke passed: production request policy, two interactive frames, management API isolation, packaged Playwright capture.",
  );
} finally {
  await captureBrowser?.close();
  await app?.close();
  await f.close();
}
