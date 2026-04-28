// n2n desktop shell — Electron just opens a window pointing at the Next.js
// renderer (dev) or the static export (production). The backend runs as a
// separate Bun process (server/index.ts), so this file no longer registers
// any IPC handlers.

const { app, BrowserWindow, protocol, net } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

const DEV_URL = process.env.N2N_DEV_URL || "http://localhost:3000";

// Custom scheme for the static export. Loading via file:// breaks because
// Next emits absolute URLs (`/_next/static/...`) that resolve to filesystem
// root under file://. Under app:// these resolve correctly inside out/.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0f172a",
    icon: path.join(__dirname, "..", "assets", "icon.svg"),
    title: "n2n",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (!app.isPackaged) {
    win.loadURL(DEV_URL);
  } else {
    win.loadURL("app://-/index.html");
  }
}

app.whenReady().then(() => {
  if (app.isPackaged) {
    const outDir = path.join(__dirname, "..", "out");
    protocol.handle("app", (req) => {
      // app://-/index.html → out/index.html
      // app://-/_next/static/... → out/_next/static/...
      const url = new URL(req.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "" || pathname === "/") pathname = "/index.html";
      // Next.js with trailingSlash: routes like /connect/ map to
      // /connect/index.html on disk.
      if (pathname.endsWith("/")) pathname += "index.html";
      const filePath = path.join(outDir, pathname);
      return net.fetch(pathToFileURL(filePath).toString());
    });
  }
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
