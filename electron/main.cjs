const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const { app, BrowserWindow, Menu, Tray, nativeImage } = require("electron");

const SERVER_PORT = Number(process.env.PORT || 33445);
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

let mainWindow = null;
let serverProcess = null;
let shuttingDown = false;
let tray = null;
let quitting = false;

function getWindowIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app", "build", "icons", "512x512.png")
    : path.join(__dirname, "..", "build", "icons", "512x512.png");
}

function getTrayIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app", "build", "icons", "256x256.png")
    : path.join(__dirname, "..", "build", "icons", "256x256.png");
}

function showWindow() {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function hideWindow() {
  if (!mainWindow) {
    return;
  }

  mainWindow.hide();
}

function createTray() {
  if (tray) {
    return;
  }

  tray = new Tray(nativeImage.createFromPath(getTrayIconPath()));
  tray.setToolTip("Hmd Chat");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show Hmd Chat",
        click: showWindow
      },
      {
        type: "separator"
      },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );

  tray.on("click", () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isVisible()) {
      hideWindow();
      return;
    }

    showWindow();
  });
}

function configureAutoLaunch() {
  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    autoHideMenuBar: true,
    backgroundColor: "#f4f1ea",
    icon: nativeImage.createFromPath(getWindowIconPath()),
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.on("close", (event) => {
    if (quitting) {
      return;
    }

    event.preventDefault();
    hideWindow();
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestHealth() {
  return new Promise((resolve, reject) => {
    const req = http.get(`${SERVER_URL}/health`, (res) => {
      res.resume();
      if (res.statusCode === 200) {
        resolve();
        return;
      }
      reject(new Error(`Health check failed with ${res.statusCode}`));
    });

    req.on("error", reject);
    req.setTimeout(1000, () => {
      req.destroy(new Error("Health check timeout"));
    });
  });
}

async function waitForServerReady() {
  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    try {
      await requestHealth();
      return;
    } catch (_error) {
      await wait(250);
    }
  }

  throw new Error("Server did not become ready in time.");
}

function startServer() {
  const serverEntry = app.isPackaged
    ? path.join(process.resourcesPath, "app", "src", "server.js")
    : path.join(__dirname, "..", "src", "server.js");
  const serverDataDir = path.join(app.getPath("userData"), "server-data");

  serverProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      DATA_DIR: serverDataDir,
      PORT: String(SERVER_PORT)
    },
    stdio: "inherit"
  });

  serverProcess.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`Server exited unexpectedly (${signal || code}).`);
      app.quit();
    }
  });
}

async function stopServer() {
  if (!serverProcess || serverProcess.killed) {
    return;
  }

  const child = serverProcess;

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 2000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill("SIGTERM");
  });
}

async function boot() {
  app.setName("Hmd Chat");
  createTray();
  configureAutoLaunch();
  createWindow();
  startServer();
  await waitForServerReady();
  await mainWindow.loadURL(SERVER_URL);
}

app.whenReady().then(boot).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("activate", async () => {
  if (mainWindow === null) {
    createWindow();
    await mainWindow.loadURL(SERVER_URL);
    return;
  }

  showWindow();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", async (event) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  quitting = true;
  event.preventDefault();
  await stopServer();
  app.quit();
});
