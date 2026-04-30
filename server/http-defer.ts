// Shared registry for HTTP requests whose response is held open until the
// graph drives it. Used by both `rest-endpoint` (deferred mode) and
// `webhook-receive` (deferred mode). The graph-side modules `rest-send`
// and `rest-end` push chunks / close the response by connectionId, so a
// single pair of modules works for either trigger source.
//
// State machine per connection:
//   1. Trigger handler calls registerDeferredHttp → gets back a Promise<Response>.
//      The Bun.serve fetch() returns that promise.
//   2. Graph runs. First httpSend converts the pending entry into a
//      streaming Response (status / headers committed at this point) and
//      enqueues the first chunk.
//   3. Subsequent httpSend calls enqueue more chunks (status/headers
//      ignored — already on the wire).
//   4. httpEnd closes the stream (or if no httpSend ran, sends a single
//      complete Response with the final body).
//   5. Timeout / client abort errors the stream and drops the entry.

const TEXT_ENCODER = new TextEncoder();

type DeferredConn = {
  connectionId: string;
  projectId: string;
  nodeId: string;
  source: "rest" | "webhook";
  status: number;
  contentType: string;
  headers: Record<string, string>;
  resolveResponse: (r: Response) => void;
  streamController: ReadableStreamDefaultController<Uint8Array> | null;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

const deferredConns = new Map<string, DeferredConn>();

export type DeferredHttpInit = {
  connectionId: string;
  projectId: string;
  nodeId: string;
  source: "rest" | "webhook";
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /**
   * Called when the connection is dropped *before* httpSend / httpEnd
   * could finalize the response (timeout / client abort / shutdown). The
   * caller can use this to cancel any work the graph still has running.
   */
  onDrop?: (reason: "timeout" | "abort" | "shutdown") => void;
};

/**
 * Register a pending HTTP connection. Returns the Response promise that
 * the trigger handler returns from its `fetch()`. The promise resolves
 * either when httpSend (first call) / httpEnd flips the state, or when
 * timeout / abort happens.
 */
export function registerDeferredHttp(init: DeferredHttpInit): Promise<Response> {
  const timeoutMs = init.timeoutMs && init.timeoutMs > 0 ? init.timeoutMs : 30_000;

  let resolveFn!: (r: Response) => void;
  const respPromise = new Promise<Response>((resolve) => { resolveFn = resolve; });

  const conn: DeferredConn = {
    connectionId: init.connectionId,
    projectId: init.projectId,
    nodeId: init.nodeId,
    source: init.source,
    status: typeof init.status === "number" ? init.status : 200,
    contentType: init.contentType || "application/json",
    headers: { "Access-Control-Allow-Origin": "*", ...(init.headers || {}) },
    resolveResponse: resolveFn,
    streamController: null,
    closed: false,
    timer: null,
  };

  conn.timer = setTimeout(() => dropConn(conn, "timeout", timeoutMs), timeoutMs);
  if (init.abortSignal) {
    const handler = () => dropConn(conn, "abort", timeoutMs);
    try { init.abortSignal.addEventListener("abort", handler, { once: true }); } catch {}
  }

  deferredConns.set(init.connectionId, conn);

  if (init.onDrop) {
    (conn as any).__onDrop = init.onDrop;
  }

  return respPromise;
}

function dropConn(conn: DeferredConn, reason: "timeout" | "abort" | "shutdown", timeoutMs?: number): void {
  if (conn.closed) return;
  conn.closed = true;
  if (conn.timer) clearTimeout(conn.timer);
  if (conn.streamController) {
    try { conn.streamController.error(new Error(`http-defer: ${reason}`)); } catch {}
  } else {
    try {
      const status = reason === "abort" ? 499 : reason === "shutdown" ? 503 : 504;
      const body = reason === "timeout"
        ? `request timeout after ${timeoutMs ?? "?"}ms (no rest-end)`
        : reason === "abort" ? "client aborted" : "server shutdown";
      conn.resolveResponse(
        new Response(body, {
          status,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        }),
      );
    } catch {}
  }
  const onDrop = (conn as any).__onDrop as ((r: typeof reason) => void) | undefined;
  if (onDrop) {
    try { onDrop(reason); } catch {}
  }
  deferredConns.delete(conn.connectionId);
}

function toBytes(data: unknown, isBinary: boolean): Uint8Array {
  if (data === null || data === undefined) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  const s = typeof data === "string" ? data : JSON.stringify(data);
  if (isBinary) {
    try { return Uint8Array.from(Buffer.from(s, "base64")); }
    catch { return TEXT_ENCODER.encode(s); }
  }
  return TEXT_ENCODER.encode(s);
}

export type HttpSendOpts = {
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
  isBinary?: boolean;
};

/**
 * Push a chunk into a deferred connection. The first call commits status
 * / contentType / headers and starts the streaming Response; later calls
 * ignore those opts (already on the wire).
 */
export function httpSend(
  connectionId: string,
  data: unknown,
  opts: HttpSendOpts = {},
): { sent: number; misses: number } {
  const conn = deferredConns.get(connectionId);
  if (!conn || conn.closed) return { sent: 0, misses: 1 };

  const bytes = toBytes(data, !!opts.isBinary);

  if (!conn.streamController) {
    if (typeof opts.status === "number") conn.status = opts.status;
    if (opts.contentType) conn.contentType = opts.contentType;
    if (opts.headers) Object.assign(conn.headers, opts.headers);

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      cancel() {
        if (!conn.closed) {
          conn.closed = true;
          if (conn.timer) clearTimeout(conn.timer);
          deferredConns.delete(conn.connectionId);
        }
      },
    });
    conn.streamController = controller;
    const respHeaders: Record<string, string> = {
      "Content-Type": conn.contentType,
      ...conn.headers,
    };
    conn.resolveResponse(
      new Response(stream, { status: conn.status, headers: respHeaders }),
    );
  }

  if (bytes.byteLength > 0) {
    try { conn.streamController.enqueue(bytes); }
    catch { return { sent: 0, misses: 1 }; }
  }
  return { sent: 1, misses: 0 };
}

/**
 * Send the final chunk (optional) and close the connection. With no
 * prior httpSend, builds a single complete Response; otherwise appends
 * the chunk and closes the stream.
 */
export function httpEnd(
  connectionId: string,
  data: unknown,
  opts: HttpSendOpts = {},
): { sent: number; misses: number } {
  const conn = deferredConns.get(connectionId);
  if (!conn || conn.closed) return { sent: 0, misses: 1 };

  const bytes = toBytes(data, !!opts.isBinary);

  if (!conn.streamController) {
    if (typeof opts.status === "number") conn.status = opts.status;
    if (opts.contentType) conn.contentType = opts.contentType;
    if (opts.headers) Object.assign(conn.headers, opts.headers);
    const respHeaders: Record<string, string> = {
      "Content-Type": conn.contentType,
      ...conn.headers,
    };
    conn.resolveResponse(
      new Response(bytes, { status: conn.status, headers: respHeaders }),
    );
  } else {
    if (bytes.byteLength > 0) {
      try { conn.streamController.enqueue(bytes); } catch {}
    }
    try { conn.streamController.close(); } catch {}
  }

  conn.closed = true;
  if (conn.timer) clearTimeout(conn.timer);
  deferredConns.delete(connectionId);
  return { sent: 1, misses: 0 };
}

/** Drop every pending conn. Called on graceful shutdown. */
export function tearDownDeferredHttp(): void {
  for (const [, conn] of [...deferredConns]) {
    dropConn(conn, "shutdown");
  }
  deferredConns.clear();
}

/** Cheap membership check used by graph-runtime to validate that a UUID
 *  it pulled from an edge is *actually* a live deferred connection (and
 *  not e.g. a random module's output that happens to look like a UUID).
 */
export function hasDeferredHttp(connectionId: string): boolean {
  return deferredConns.has(connectionId);
}

/** Diagnostics. */
export function listDeferredHttp(): Array<{
  connectionId: string;
  source: "rest" | "webhook";
  projectId: string;
  nodeId: string;
  streaming: boolean;
}> {
  return [...deferredConns.values()].map((c) => ({
    connectionId: c.connectionId,
    source: c.source,
    projectId: c.projectId,
    nodeId: c.nodeId,
    streaming: c.streamController !== null,
  }));
}
