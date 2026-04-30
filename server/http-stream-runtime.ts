// Streaming HTTP fetch. Unlike `http-request` (Python, buffered), this
// reads the response progressively and parses it as one of:
//
//   "sse"     — Server-Sent Events. Splits on `\n\n`, keeps `event:` and
//               `data:` per record, returns an array
//               `[{ event, data, id?, raw }, …]`. Multiple `data:` lines
//               within one record are joined with `\n` per the spec.
//   "ndjson"  — One JSON object per line; each parsed entry is pushed.
//   "lines"   — Plain newline-split, no parsing.
//   "chunks"  — Raw decoded text per stream chunk (whatever boundaries
//               the network sends). Useful for "any other format".
//
// Common params: same as http-request (method, url, headers, body, …).
// Output: `events` (array), `status`, `count`, `truncated`.

import type { RunResult } from "./graph-types.ts";

type Mode = "sse" | "ndjson" | "lines" | "chunks";

type SseEvent = {
  event: string | null;
  data: string;
  id: string | null;
  raw: string;
};

function buildHeaders(
  substituted: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const h = substituted.headers;
  if (h && typeof h === "object" && !Array.isArray(h)) {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (k) out[String(k)] = String(v ?? "");
    }
  }
  const auth = String(substituted.auth_type || "none");
  const value = String(substituted.auth_value || "").trim();
  if (auth === "bearer" && value) out["Authorization"] = `Bearer ${value}`;
  if (auth === "basic" && value) {
    out["Authorization"] = `Basic ${Buffer.from(value).toString("base64")}`;
  }
  const ct = String(substituted.content_type || "").trim();
  if (ct && !out["Content-Type"]) out["Content-Type"] = ct;
  return out;
}

function parseSseRecord(record: string): SseEvent {
  let event: string | null = null;
  let id: string | null = null;
  const dataLines: string[] = [];
  for (const line of record.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let val = idx === -1 ? "" : line.slice(idx + 1);
    if (val.startsWith(" ")) val = val.slice(1);
    if (field === "data") dataLines.push(val);
    else if (field === "event") event = val;
    else if (field === "id") id = val;
  }
  return { event, data: dataLines.join("\n"), id, raw: record };
}

export async function runHttpStream(
  substituted: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Promise<RunResult> {
  const method = String(substituted.method || "GET").toUpperCase();
  const url = String(substituted.url || "").trim();
  if (!url) return { ok: false, error: "http-stream: url requise" };

  const mode = String(substituted.mode || "sse") as Mode;
  if (!["sse", "ndjson", "lines", "chunks"].includes(mode)) {
    return { ok: false, error: `http-stream: mode inconnu "${mode}"` };
  }

  const headers = buildHeaders(substituted);
  // SSE servers expect Accept: text/event-stream — set it for the user
  // unless they overrode it explicitly.
  if (mode === "sse" && !headers["Accept"]) {
    headers["Accept"] = "text/event-stream";
  }

  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const raw = inputs.body ?? substituted.body;
    if (typeof raw === "string") body = raw;
    else if (raw !== null && raw !== undefined) body = JSON.stringify(raw);
  }

  const maxEvents = Number(substituted.max_events ?? 0) || 0;
  const timeoutMs = Number(substituted.timeout_ms ?? 0) || 0;
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) timer = setTimeout(() => ac.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body,
      signal: ac.signal,
      redirect: "follow",
    });
  } catch (e: any) {
    if (timer) clearTimeout(timer);
    return { ok: false, error: `http-stream fetch: ${e?.message || e}` };
  }
  if (!resp.body) {
    if (timer) clearTimeout(timer);
    return { ok: false, error: `http-stream: pas de body (status ${resp.status})` };
  }

  const events: unknown[] = [];
  let truncated = false;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const push = (e: unknown): boolean => {
    events.push(e);
    if (maxEvents > 0 && events.length >= maxEvents) {
      truncated = true;
      try { reader.cancel().catch(() => undefined); } catch {}
      return false;
    }
    return true;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      if (mode === "sse") {
        // SSE records separated by blank line (\n\n or \r\n\r\n).
        let split: number;
        while ((split = buf.search(/\r?\n\r?\n/)) >= 0) {
          const record = buf.slice(0, split);
          buf = buf.slice(split + (buf[split] === "\r" ? 4 : 2));
          if (record.trim()) {
            if (!push(parseSseRecord(record))) break;
          }
        }
      } else if (mode === "ndjson" || mode === "lines") {
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (!line && mode === "ndjson") continue; // skip blank lines in NDJSON
          if (mode === "ndjson") {
            try { if (!push(JSON.parse(line))) break; }
            catch (e: any) { if (!push({ error: `JSON parse: ${e?.message}`, raw: line })) break; }
          } else {
            if (!push(line)) break;
          }
        }
      } else if (mode === "chunks") {
        // Emit each decoded chunk as-is.
        if (!push(buf)) break;
        buf = "";
      }
      if (truncated) break;
    }

    // Flush trailing buffer if mode = sse with last record OR ndjson last line
    if (!truncated && buf.trim()) {
      if (mode === "sse") events.push(parseSseRecord(buf));
      else if (mode === "ndjson") {
        try { events.push(JSON.parse(buf)); }
        catch (e: any) { events.push({ error: `JSON parse: ${e?.message}`, raw: buf }); }
      } else if (mode === "lines") events.push(buf);
      else if (mode === "chunks") events.push(buf);
    }
  } catch (e: any) {
    if (timer) clearTimeout(timer);
    if (e?.name === "AbortError") {
      return {
        ok: true,
        outputs: { events, status: resp.status, count: events.length, truncated: true },
      };
    }
    return { ok: false, error: `http-stream read: ${e?.message || e}` };
  }
  if (timer) clearTimeout(timer);
  return {
    ok: true,
    outputs: { events, status: resp.status, count: events.length, truncated },
  };
}
