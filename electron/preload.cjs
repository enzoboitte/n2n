// All backend logic now lives in the Bun server (server/index.ts). The
// renderer talks to it directly over HTTP + SSE, so this preload is empty
// on purpose — keeping it lets us keep contextIsolation on without exposing
// any IPC bridge. window.n2n stays undefined so getApi() falls through to
// the HTTP client.
