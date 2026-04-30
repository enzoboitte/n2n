// SSE proxy to a local llama.cpp / OpenAI-compatible chat endpoint. Streams
// `chunk` events for tokens and ends with a `done` event carrying the
// final `{ ok, toolCalls, finishReason }`. Tool-calling deltas are
// accumulated by index since llama.cpp emits them piecewise.
//
// `aiChatStream` returns an SSE Response; abort via `abortAiStream(id)`.

import { LLAMA_URL } from "./config.ts";
import { corsHeaders } from "./http-helpers.ts";

const activeStreams = new Map<string, AbortController>();

export function aiChatStream(args: { id: string; messages: any[]; options?: any }): Response {
  const { id, messages, options } = args;
  const url = options?.url || LLAMA_URL;
  const controller = new AbortController();
  activeStreams.set(id, controller);

  const body: any = {
    model: options?.model || "local",
    messages,
    stream: true,
    temperature: options?.temperature ?? 0.7,
  };
  if (Array.isArray(options?.tools) && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options?.tool_choice || "auto";
  }
  if (typeof options?.enable_thinking === "boolean") {
    body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), enable_thinking: options.enable_thinking };
  }

  // Tool calls accumulator (streamed in pieces by the model)
  const toolCallsByIndex = new Map<number, any>();
  let inReasoning = false;
  let finishReason: string | null = null;
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const sendChunk = (text: string) => {
        ctrl.enqueue(enc.encode(`event: chunk\ndata: ${JSON.stringify(text)}\n\n`));
      };
      const sendDone = (result: any) => {
        ctrl.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify(result)}\n\n`));
        ctrl.close();
      };

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err: any) {
        activeStreams.delete(id);
        if (err.name === "AbortError") return sendDone({ ok: true, aborted: true });
        return sendDone({ ok: false, error: `fetch: ${err.message || err}` });
      }
      if (!resp.ok) {
        activeStreams.delete(id);
        let errBody = "";
        try { errBody = await resp.text(); } catch {}
        return sendDone({ ok: false, error: `HTTP ${resp.status}: ${errBody.slice(0, 500)}` });
      }
      if (!resp.body) {
        activeStreams.delete(id);
        return sendDone({ ok: false, error: "Pas de corps de réponse" });
      }

      const reader = resp.body.getReader();
      controller.signal.addEventListener("abort", () => { reader.cancel().catch(() => {}); });
      const decoder = new TextDecoder();
      let buffer = "";

      const finalize = () => {
        const toolCalls = Array.from(toolCallsByIndex.values()).filter((tc) => tc.function?.name);
        sendDone({ ok: true, toolCalls, finishReason });
        activeStreams.delete(id);
      };

      try {
        while (true) {
          if (controller.signal.aborted) {
            sendDone({ ok: true, aborted: true });
            activeStreams.delete(id);
            return;
          }
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              if (inReasoning) { sendChunk("</think>"); inReasoning = false; }
              return finalize();
            }
            try {
              const json = JSON.parse(data);
              const choice = json?.choices?.[0];
              if (!choice) continue;
              if (choice.finish_reason) finishReason = choice.finish_reason;
              const delta = choice.delta;
              if (!delta) continue;
              const reasoning = delta.reasoning_content;
              const content = delta.content;
              if (reasoning) {
                if (!inReasoning) { sendChunk("<think>"); inReasoning = true; }
                sendChunk(reasoning);
              }
              if (content) {
                if (inReasoning) { sendChunk("</think>"); inReasoning = false; }
                sendChunk(content);
              }
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  let acc = toolCallsByIndex.get(idx);
                  if (!acc) {
                    acc = { id: "", type: "function", function: { name: "", arguments: "" } };
                    toolCallsByIndex.set(idx, acc);
                  }
                  if (tc.id) acc.id = tc.id;
                  if (tc.type) acc.type = tc.type;
                  if (tc.function?.name) acc.function.name = tc.function.name;
                  if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
                }
              }
            } catch {}
          }
        }
        if (inReasoning) { sendChunk("</think>"); inReasoning = false; }
        finalize();
      } catch (err: any) {
        if (err.name === "AbortError") { sendDone({ ok: true, aborted: true }); }
        else { sendDone({ ok: false, error: `stream: ${err.message || err}` }); }
        activeStreams.delete(id);
      }
    },
    cancel() {
      controller.abort();
      activeStreams.delete(id);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(),
    },
  });
}

export function abortAiStream(id: string): void {
  const c = activeStreams.get(id);
  if (c) c.abort();
}
