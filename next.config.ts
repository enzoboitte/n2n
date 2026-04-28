import type { NextConfig } from "next";

// Static export so the UI can be deployed on any static host (Apache, Nginx,
// CDN, GitHub Pages…). Every page is pre-rendered as plain HTML+JS+CSS, no
// Node runtime required at serve time. Server-side features (API routes,
// SSR, image optimization) are unused — the app is a pure SPA that talks
// HTTP/SSE to the n2n backend whose URL is configured at runtime by the user
// via the Settings modal (persisted in localStorage).
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Trailing slashes make Apache happy (`/foo/` → `/foo/index.html`).
  trailingSlash: true,
};

export default nextConfig;
