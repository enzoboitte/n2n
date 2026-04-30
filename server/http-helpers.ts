// Tiny HTTP utility set — CORS, JSON / error responses, body decoder, and
// the `route()` factory used to assemble the route table. Pure helpers,
// shared by every endpoint.

import { ALLOWED_ORIGIN } from "./config.ts";

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Stream-Id",
    "Access-Control-Max-Age": "86400",
  };
}

export function json(data: any, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extra },
  });
}

export function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

export async function readJson<T = any>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try { return JSON.parse(text); }
  catch { throw new Error("Body JSON invalide"); }
}

export type RouteMatch = {
  pattern: RegExp;
  method: string;
  handler: (req: Request, params: Record<string, string>) => Promise<Response> | Response;
};

export function route(
  method: string,
  pattern: string,
  handler: RouteMatch["handler"],
): RouteMatch {
  // /api/projects/:id/rename → captures :id
  const re = new RegExp("^" + pattern.replace(/:[a-zA-Z]+/g, "([^/]+)").replace(/\*$/, "(.*)") + "$");
  const keys = (pattern.match(/:[a-zA-Z]+/g) || []).map((s) => s.slice(1));
  if (pattern.endsWith("*")) keys.push("rest");
  return {
    pattern: re,
    method,
    handler: async (req, _p) => {
      const m = re.exec(new URL(req.url).pathname);
      const params: Record<string, string> = {};
      if (m) keys.forEach((k, i) => { params[k] = m[i + 1]; });
      return handler(req, params);
    },
  };
}
