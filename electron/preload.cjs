// Most of the renderer talks to the Bun server directly over HTTP + SSE,
// so this preload stays minimal. We do expose one bridge: a local HTTP
// listener that forwards OAuth callbacks to the remote n2n server's
// `/oauth/<name>/...` proxy, so users running the Electron client against
// a remote backend never have to set up SSH port forwards manually.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("n2nElectron", {
  oauthBridge: {
    start: (opts) => ipcRenderer.invoke("oauth-bridge:start", opts),
    stop: (port) => ipcRenderer.invoke("oauth-bridge:stop", port),
    list: () => ipcRenderer.invoke("oauth-bridge:list"),
  },
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
