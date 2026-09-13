import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
} from "electron";
import { fileURLToPath } from "node:url";
import { createAgentUi } from "../src/discord-agent-ui.mjs";
import { allowedDesktopRequest, allowedExternalUrl } from "./security.mjs";
import { LocalCodexTasks } from "./local-tasks.mjs";

const localTasks = new LocalCodexTasks();

app.setName("IDO Agent");
app.setAppUserModelId("org.idobot.agent");
let window,
  ui,
  stopping = false,
  stopped = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    window?.setTitle("IDO Agent — タスクを停止して終了しています…");
    void Promise.resolve(ui?.close())
      .then(() => {
        stopped = true;
        app.quit();
      })
      .catch(() => {
        dialog.showErrorBox(
          "終了処理",
          "タスクの停止処理を完了できませんでした。アプリを再度終了してください。",
        );
        stopping = false;
      });
  });
  app.on("window-all-closed", () => app.quit());
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    try {
      ui = await createAgentUi({
        assetDirectory: new URL("./", import.meta.url),
        pickFolder: async () => {
          const result = await dialog.showOpenDialog(window, {
            title: "作業するGitリポジトリを選択",
            properties: ["openDirectory"],
          });
          return result.canceled ? "" : result.filePaths[0];
        },
      });
      const address = new URL(ui.url);
      const capability = address.hash.slice(1);
      address.hash = "";
      window = new BrowserWindow({
        icon: fileURLToPath(new URL("./icon.ico", import.meta.url)),
        width: 1280,
        height: 840,
        minWidth: 920,
        minHeight: 640,
        title: "IDO Agent",
        backgroundColor: "#111318",
        show: true,
        webPreferences: {
          preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          devTools: !app.isPackaged,
        },
      });
      const trusted = (event) =>
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame &&
        event.senderFrame.url === address.href;
      ipcMain.handle("ido:request", async (event, path, input) => {
        if (!trusted(event) || stopping || !allowedDesktopRequest(path, input))
          throw new Error("この操作は許可されていません。");
        if (path === "/local-tasks") {
          localTasks.setEnabled(input.enabled);
          return { enabled: input.enabled };
        }
        const response = await fetch(new URL(path, address), {
          method: input === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${capability}`,
            Origin: address.origin,
            "Content-Type": "application/json",
          },
          body: input === undefined ? undefined : JSON.stringify(input),
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error ?? "操作に失敗しました。");
        if (path === "/status") {
          const local = await localTasks.list();
          result.localTasks = {
            enabled: local.enabled,
            available: local.available,
          };
          result.tasks.push(...local.tasks);
        }
        return result;
      });
      ipcMain.handle("ido:quit", (event) => {
        if (trusted(event)) app.quit();
      });
      ipcMain.handle("ido:external", async (event, value) => {
        if (trusted(event) && allowedExternalUrl(value))
          await shell.openExternal(value);
      });
      window.webContents.on("will-navigate", (event, url) => {
        if (url !== address.href) event.preventDefault();
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("render-process-gone", () => app.quit());
      window.on("close", (event) => {
        if (!stopped) {
          event.preventDefault();
          app.quit();
        }
      });
      await window.loadURL(address.href);
    } catch {
      dialog.showErrorBox(
        "IDO Agent",
        "起動できませんでした。インストールを確認し、もう一度起動してください。",
      );
      app.quit();
    }
  });
}
