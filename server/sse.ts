// Server-Sent Events fan-out used to push live updates to every connected
// renderer (modulesChanged, mcpChanged, nodeRunStart, nodeRunEnd,
// envChanged, runtimesChanged). Single global stream, no per-client
// filtering — clients pick what they react to in their listeners.

export type EventName =
  | "modulesChanged"
  | "mcpChanged"
  | "nodeRunStart"
  | "nodeRunEnd"
  | "envChanged"
  | "runtimesChanged";

const eventClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const sseEncoder = new TextEncoder();

export function broadcast(event: EventName, data?: any): void {
  const payload = sseEncoder.encode(
    `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`,
  );
  for (const c of eventClients) {
    try { c.enqueue(payload); } catch {}
  }
}

export function eventStream(corsHeaders: Record<string, string> = {}): Response {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      eventClients.add(controller);
      // Initial comment to flush headers and keep proxies alive
      controller.enqueue(sseEncoder.encode(": connected\n\n"));
    },
    cancel() {
      if (controllerRef) eventClients.delete(controllerRef);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders,
    },
  });
}
