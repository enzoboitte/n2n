// n2n desktop shell — Electron just opens a window pointing at the Next.js
// renderer (dev) or the static export (production). The backend runs as a
// separate Bun process (server/index.ts).
//
// Single IPC bridge: oauth-bridge. When n2n is connecting to a *remote* n2n
// server, OAuth callbacks would normally hit `localhost:<port>` on the
// remote machine — unreachable from the user's browser. We open a local
// HTTP listener on the same port and forward incoming requests through the
// remote server's `/oauth/<name>/...` proxy. No SSH, no extra config.

const { app, BrowserWindow, protocol, net, ipcMain, shell } = require("electron");
const http = require("node:http");
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

// ---- OAuth tunnel ----
//
// Map<port, { server: http.Server; serverName: string; apiBase: string }>.
// We key by port so the user can start one bridge per concurrent OAuth flow.
const oauthBridges = new Map();

function stopBridge(port) {
  const entry = oauthBridges.get(port);
  if (!entry) return false;
  oauthBridges.delete(port);
  try { entry.server.close(); } catch {}
  return true;
}

ipcMain.handle("oauth-bridge:start", async (_e, opts) => {
  const port = Number(opts?.port);
  const serverName = String(opts?.serverName || "");
  const apiBase = String(opts?.apiBase || "").replace(/\/+$/, "");
  const token = typeof opts?.token === "string" ? opts.token : null;
  if (!port || port < 1 || port > 65535) throw new Error("Port invalide");
  if (!serverName) throw new Error("serverName requis");
  if (!apiBase) throw new Error("apiBase requis");

  // Already bridging this port? Replace.
  stopBridge(port);

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      const tail = reqUrl.pathname.replace(/^\/+/, "") + reqUrl.search;
      const target = `${apiBase}/oauth/${encodeURIComponent(serverName)}/${tail}`;
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (lk === "host" || lk === "connection" || lk === "content-length") continue;
        if (Array.isArray(v)) headers[k] = v.join(", ");
        else if (typeof v === "string") headers[k] = v;
      }
      if (token) headers["Authorization"] = `Bearer ${token}`;

      let body;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        if (chunks.length) body = Buffer.concat(chunks);
      }

      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
      });
      res.statusCode = upstream.status;
      upstream.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (lk === "transfer-encoding" || lk === "connection") return;
        res.setHeader(k, v);
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
    } catch (err) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`OAuth bridge error: ${err && err.message ? err.message : err}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  oauthBridges.set(port, { server, serverName, apiBase });
  console.log(`[n2n] oauth-bridge listening on 127.0.0.1:${port} → ${apiBase}/oauth/${serverName}/`);
  return { ok: true, port };
});

ipcMain.handle("oauth-bridge:stop", async (_e, port) => {
  const stopped = stopBridge(Number(port));
  return { ok: true, stopped };
});

ipcMain.handle("oauth-bridge:list", async () => {
  return Array.from(oauthBridges.entries()).map(([port, b]) => ({
    port,
    serverName: b.serverName,
    apiBase: b.apiBase,
  }));
});

// Open URLs in the user's default system browser, not inside Electron.
ipcMain.handle("open-external", async (_e, url) => {
  if (typeof url !== "string") throw new Error("URL invalide");
  // Allow only http(s) — refuse file:, javascript:, etc.
  if (!/^https?:\/\//i.test(url)) throw new Error("Schéma non autorisé");
  await shell.openExternal(url);
  return { ok: true };
});

app.on("before-quit", () => {
  for (const port of Array.from(oauthBridges.keys())) stopBridge(port);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
