const { contextBridge, ipcRenderer } = require("electron");

let aiSeq = 0;

contextBridge.exposeInMainWorld("n2n", {
  listModules: () => ipcRenderer.invoke("modules:list"),
  runModule: (id, inputs, params, letters, env) =>
    ipcRenderer.invoke("module:run", { id, inputs, params, letters, env }),
  openModulesFolder: () => ipcRenderer.invoke("modules:openFolder"),
  loadEnv: () => ipcRenderer.invoke("env:load"),
  saveEnv: (env) => ipcRenderer.invoke("env:save", env),
  onModulesChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("modules:changed", handler);
    return () => ipcRenderer.removeListener("modules:changed", handler);
  },
  chatStream: (messages, onChunk, options) => {
    const id = `${Date.now()}-${++aiSeq}`;
    const handler = (_e, chunk) => onChunk(chunk);
    ipcRenderer.on(`ai:chunk:${id}`, handler);
    const promise = ipcRenderer
      .invoke("ai:chat", { id, messages, options })
      .finally(() => ipcRenderer.removeListener(`ai:chunk:${id}`, handler));
    return {
      promise,
      abort: () => ipcRenderer.invoke("ai:abort", { id }),
    };
  },
  // Projets
  listProjects: () => ipcRenderer.invoke("projects:list"),
  loadProject: (id) => ipcRenderer.invoke("projects:load", { id }),
  saveProject: (project) => ipcRenderer.invoke("projects:save", project),
  createProject: (name) => ipcRenderer.invoke("projects:create", { name }),
  renameProject: (id, name) =>
    ipcRenderer.invoke("projects:rename", { id, name }),
  deleteProject: (id) => ipcRenderer.invoke("projects:delete", { id }),
  duplicateProject: (id) => ipcRenderer.invoke("projects:duplicate", { id }),
  getActiveProjectId: () => ipcRenderer.invoke("projects:getActive"),
  setActiveProjectId: (id) => ipcRenderer.invoke("projects:setActive", { id }),
  exportProjectToFile: (id) =>
    ipcRenderer.invoke("projects:exportToFile", { id }),
  importProjectFromFile: () => ipcRenderer.invoke("projects:importFromFile"),

  // Cron
  cronRegister: (id, intervalMs) =>
    ipcRenderer.invoke("cron:register", { id, intervalMs }),
  cronUnregister: (id) => ipcRenderer.invoke("cron:unregister", { id }),
  cronUnregisterAll: () => ipcRenderer.invoke("cron:unregisterAll"),
  onCronTick: (callback) => {
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on("cron:tick", handler);
    return () => ipcRenderer.removeListener("cron:tick", handler);
  },

  // Webhooks
  webhookRegister: (nodeId, path, response) =>
    ipcRenderer.invoke("webhook:register", { nodeId, path, response }),
  webhookUnregister: (nodeId) =>
    ipcRenderer.invoke("webhook:unregister", { nodeId }),
  webhookUnregisterAll: () => ipcRenderer.invoke("webhook:unregisterAll"),
  webhookPort: () => ipcRenderer.invoke("webhook:port"),
  onWebhookFired: (callback) => {
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on("webhook:fired", handler);
    return () => ipcRenderer.removeListener("webhook:fired", handler);
  },

  // MCP
  mcpList: () => ipcRenderer.invoke("mcp:list"),
  mcpSave: (name, config) =>
    ipcRenderer.invoke("mcp:save", { name, config }),
  mcpDelete: (name) => ipcRenderer.invoke("mcp:delete", { name }),
  mcpRestart: (name) => ipcRenderer.invoke("mcp:restart", { name }),
  mcpCallTool: (server, tool, args) =>
    ipcRenderer.invoke("mcp:callTool", { server, tool, args }),
  onMcpChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("mcp:changed", handler);
    return () => ipcRenderer.removeListener("mcp:changed", handler);
  },

  // History
  appendHistory: (entry) => ipcRenderer.invoke("history:append", entry),
  readHistory: (limit) => ipcRenderer.invoke("history:read", { limit }),
  clearHistory: () => ipcRenderer.invoke("history:clear"),

  // Module FS (sandboxed to ~/.n2n/modules/<id>/)
  createModule: (args) => ipcRenderer.invoke("module:create", args),
  deleteModule: (id) => ipcRenderer.invoke("module:delete", { id }),
  listModuleFiles: (id) => ipcRenderer.invoke("module:fs:list", { id }),
  readModuleFile: (id, file) =>
    ipcRenderer.invoke("module:fs:read", { id, file }),
  writeModuleFile: (id, file, content) =>
    ipcRenderer.invoke("module:fs:write", { id, file, content }),
  deleteModuleFile: (id, file) =>
    ipcRenderer.invoke("module:fs:delete", { id, file }),
});
