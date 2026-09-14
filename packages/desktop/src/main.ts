import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "../../client/src/bootstrap/client.js";
import { dataDirectory } from "../../common/src/runtime/platform.js";
import { lifetime } from "../../common/src/runtime/lifecycle.js";
import { externalLink, localSender, parseJoinLink } from "./security.js";

app.setName("IDO Agent");
if (process.platform === "win32") app.setAppUserModelId("org.idobot.agent");
const root = dirname(fileURLToPath(import.meta.url));
let client: Client | undefined;
let window: BrowserWindow | undefined;
let close: (() => Promise<void>) | undefined;
let closing = false;
let stopped = false;
let pendingEngine: string | undefined;
function receiveLink(value: string) {
  try {
    const engine = parseJoinLink(value);
    if (
      client?.settings.deviceId ||
      client?.pairing ||
      client?.executor.active.size
    ) {
      dialog.showErrorBox(
        "IDO Agent",
        "接続先を変更する前に、現在のタスクと接続をアプリで停止してください。",
      );
      return;
    }
    pendingEngine = engine;
    if (client) client.suggestedEngine = engine;
  } catch {
    dialog.showErrorBox(
      "IDO Agent",
      "接続リンクが正しくありません。Discordで案内を開き直してください。",
    );
  }
}
// macOS sends open-url before ready; register synchronously.
app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveLink(url);
  window?.show();
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, args) => {
    for (const arg of args.filter((arg) => arg.startsWith("ido-agent:")))
      receiveLink(arg);
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void (async () => {
      try {
        await close?.();
        stopped = true;
        app.quit();
      } catch {
        closing = false;
        dialog.showErrorBox(
          "IDO Agent",
          "実行の停止を確認できませんでした。アプリ内でタスクを停止して終了を再試行してください。",
        );
      }
    })();
  });
  app.on("window-all-closed", () => app.quit());
  void app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "IDO Agent",
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          { role: "editMenu" },
        ]),
      );
      if (app.isPackaged) app.setAsDefaultProtocolClient("ido-agent");
      if (process.platform === "darwin")
        process.env.PATH = [
          ...new Set([
            ...(process.env.PATH ?? "").split(":"),
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/usr/bin",
            "/bin",
          ]),
        ].join(":");
      client = new Client(dataDirectory("client"), join(root, "ui"));
      client.desktop = {
        name: app.getName(),
        version: app.getVersion(),
        pid: process.pid,
        platform: process.platform,
      };
      close = await lifetime(client.directory, () => client!.close());
      await client.start(0);
      for (const arg of process.argv.filter((arg) =>
        arg.startsWith("ido-agent:"),
      ))
        receiveLink(arg);
      client.suggestedEngine = pendingEngine;
      window = new BrowserWindow({
        title: "IDO Agent",
        width: 1240,
        height: 860,
        minWidth: 840,
        minHeight: 600,
        icon: join(root, "icon.ico"),
        webPreferences: {
          preload: join(root, "preload.cjs"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          devTools: !app.isPackaged,
        },
      });
      window.on("close", (event) => {
        if (!stopped) {
          event.preventDefault();
          app.quit();
        }
      });
      const trusted = (url: string) =>
        !!client && localSender(url, client.origin);
      const open = (url: string) => {
        if (externalLink(url, client?.pairing?.url, client?.loginUrl))
          void shell.openExternal(url).catch(() => {});
      };
      window.webContents.on("will-navigate", (event, url) => {
        if (!trusted(url)) {
          event.preventDefault();
          open(url);
        }
      });
      window.webContents.on("will-redirect", (event, url) => {
        if (!trusted(url)) event.preventDefault();
      });
      window.webContents.setWindowOpenHandler(({ url }) => {
        open(url);
        return { action: "deny" };
      });
      window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      window.webContents.session.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.webContents.session.webRequest.onBeforeRequest(
        (details, callback) => callback({ cancel: !trusted(details.url) }),
      );
      window.webContents.session.on("will-download", (event) =>
        event.preventDefault(),
      );
      ipcMain.handle("ido:pick-directory", async (event) => {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          !trusted(event.senderFrame.url)
        )
          throw new Error("UNTRUSTED_SENDER");
        if (client?.allow || client?.executor.active.size)
          throw new Error("PAUSE_BEFORE_EDITING");
        const result = await dialog.showOpenDialog(window, {
          title: "Git作業フォルダーを選択",
          properties: ["openDirectory"],
        });
        return result.canceled ? undefined : result.filePaths[0];
      });
      await window.loadURL(client.origin);
    })
    .catch(async () => {
      dialog.showErrorBox(
        "IDO Agentを起動できません",
        "既にClientが動いていないか確認してください。終了後も起動できない場合は管理者に相談してください。保存済みの接続設定は保持されています。",
      );
      await close?.().catch(() => {});
      stopped = true;
      app.quit();
    });
}
