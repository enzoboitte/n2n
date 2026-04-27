"use client";

import { useCallback, useRef, useState } from "react";
import {
  getApi,
  type ChatHandle,
  type ChatMessage,
  type ToolCall,
  type ToolDefinition,
} from "@/lib/n2n";

const MAX_TOOL_TURNS = 16;
// Approximate char budget before we compact older messages. Leaves headroom
// for the system prompt + tool defs + the model's reasoning + completion.
const COMPACT_THRESHOLD_CHARS = 16000;
const KEEP_RECENT_MESSAGES = 4;

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

type Options = {
  systemPrompt?: string;
  tools?: ToolDefinition[];
  executor?: ToolExecutor;
  thinkingEnabled?: boolean;
};

export function useChat({
  systemPrompt,
  tools,
  executor,
  thinkingEnabled = true,
}: Options = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<ChatHandle | null>(null);
  const abortedRef = useRef(false);

  const send = useCallback(
    async (content: string) => {
      const api = getApi();
      if (!api) {
        setError("App lancée hors mode desktop.");
        return;
      }
      const trimmed = content.trim();
      if (!trimmed) return;

      abortedRef.current = false;
      const baseHistory: ChatMessage[] = [
        ...messages,
        { role: "user", content: trimmed },
      ];
      let visible: ChatMessage[] = [
        ...baseHistory,
        { role: "assistant", content: "" },
      ];
      setMessages(visible);
      setStreaming(true);
      setError(null);

      let history: ChatMessage[] = [...baseHistory];
      // Bail out of compaction once it has failed or stopped helping —
      // otherwise we'd loop summarizing on every tour.
      let compactionDisabled = false;

      try {
        for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
          const totalChars = history.reduce(
            (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
            0,
          );
          if (
            !compactionDisabled &&
            totalChars > COMPACT_THRESHOLD_CHARS &&
            history.length > KEEP_RECENT_MESSAGES + 1
          ) {
            try {
              const compacted = await compactHistory(api, history);
              const newSize = compacted.reduce(
                (s, m) =>
                  s + (typeof m.content === "string" ? m.content.length : 0),
                0,
              );
              // If the summary barely reduced size (model returned empty,
              // wrapped everything in <think>, etc.) treat it as failed and
              // never retry within this send() — that's what loops the chat.
              if (newSize >= totalChars * 0.85) {
                compactionDisabled = true;
                console.warn(
                  `[n2n] compaction skipped (no meaningful reduction: ${totalChars} -> ${newSize})`,
                );
              } else {
                history = compacted;
                visible = [...history, { role: "assistant", content: "" }];
                setMessages(visible);
              }
            } catch (err) {
              compactionDisabled = true;
              console.warn("[n2n] compaction failed:", err);
            }
          }

          const payload: ChatMessage[] = systemPrompt
            ? [{ role: "system", content: systemPrompt }, ...history]
            : history;

          let buffer = "";
          const lastRole = history[history.length - 1]?.role;
          // Thinking is opt-in (toggle) AND only on the initial user turn:
          // disabled mid tool-loop to avoid re-reasoning between every call.
          const enableThinking = thinkingEnabled && lastRole === "user";
          const handle = api.chatStream(
            payload,
            (chunk) => {
              buffer += chunk;
              setMessages((prev) => {
                const next = prev.slice();
                next[next.length - 1] = {
                  role: "assistant",
                  content: buffer,
                };
                return next;
              });
            },
            {
              tools,
              tool_choice: tools ? "auto" : undefined,
              enable_thinking: enableThinking,
            },
          );
          handleRef.current = handle;

          const result = await handle.promise;
          handleRef.current = null;

          if (!result.ok) {
            setMessages((prev) => {
              const next = prev.slice();
              next[next.length - 1] = {
                role: "assistant",
                content: buffer || `⚠ ${result.error}`,
              };
              return next;
            });
            setError(result.error);
            break;
          }

          if (abortedRef.current) {
            break;
          }

          const toolCalls = result.toolCalls ?? [];
          const assistantMsg: ChatMessage = toolCalls.length
            ? { role: "assistant", content: buffer, tool_calls: toolCalls }
            : { role: "assistant", content: buffer };

          history = [...history, assistantMsg];

          if (toolCalls.length === 0 || !executor) {
            visible = [...history];
            setMessages(visible);
            break;
          }

          const toolMessages: ChatMessage[] = [];
          for (const tc of toolCalls) {
            const toolMsg = await runOne(executor, tc);
            toolMessages.push(toolMsg);
          }
          history = [...history, ...toolMessages];
          visible = [...history, { role: "assistant", content: "" }];
          setMessages(visible);
        }
      } finally {
        handleRef.current = null;
        setStreaming(false);
      }
    },
    [messages, systemPrompt, tools, executor, thinkingEnabled],
  );

  const stop = useCallback(() => {
    abortedRef.current = true;
    handleRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    abortedRef.current = true;
    handleRef.current?.abort();
    setMessages([]);
    setError(null);
  }, []);

  return { messages, send, stop, clear, streaming, error };
}

async function runOne(
  executor: ToolExecutor,
  tc: ToolCall,
): Promise<ChatMessage> {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = tc.function.arguments
      ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
      : {};
  } catch {
    return {
      role: "tool",
      tool_call_id: tc.id,
      content: JSON.stringify({
        ok: false,
        error: `Arguments JSON invalides: ${tc.function.arguments}`,
      }),
    };
  }
  try {
    const result = await executor(tc.function.name, parsed);
    return {
      role: "tool",
      tool_call_id: tc.id,
      content: JSON.stringify({ ok: true, result }),
    };
  } catch (err) {
    return {
      role: "tool",
      tool_call_id: tc.id,
      content: JSON.stringify({
        ok: false,
        error: String((err as Error)?.message ?? err),
      }),
    };
  }
}

// ----------------- COMPACTION -----------------

const COMPACT_SYSTEM_PROMPT =
  "Tu reçois une portion de conversation entre un utilisateur et un assistant qui manipule un éditeur de graphes (n2n) via des outils. " +
  "Ton rôle est de produire un RÉSUMÉ dense qui préserve le contexte essentiel pour continuer le travail sans perte d'information critique. " +
  "Réponds UNIQUEMENT avec le résumé, sans préambule ni meta-commentaire.";

const COMPACT_USER_INSTRUCTIONS = `Résume la conversation suivante en préservant :
1. **Intention de l'utilisateur** : ce qu'il veut accomplir, ses préférences, ses corrections.
2. **Outils appelés et résultats** : les modifications faites au graphe (nœuds ajoutés/supprimés/connectés), les modules créés/modifiés, les variables d'env touchées.
3. **État courant** : structure du graphe, valeurs d'env importantes, modules sélectionnés.
4. **Sujets en cours** : ce qui était en train d'être travaillé immédiatement avant le résumé.

Sois dense (20–60 lignes max), préserve les noms exacts (ids de modules, ids de nœuds, noms de variables d'env, libellés). Liste les outils appelés et leur effet, pas leurs arguments verbeux.`;

function formatMessageForSummary(m: ChatMessage): string {
  if (m.role === "user") return `[USER] ${m.content}`;
  if (m.role === "system") return `[SYSTEM] ${m.content.slice(0, 400)}`;
  if (m.role === "tool") {
    const head = m.content.slice(0, 300);
    return `[TOOL_RESULT] ${head}${m.content.length > 300 ? " …[tronqué]" : ""}`;
  }
  // assistant
  let out = `[ASSISTANT] ${m.content}`;
  if ("tool_calls" in m && m.tool_calls && m.tool_calls.length > 0) {
    const calls = m.tool_calls
      .map((tc) => {
        const args = (tc.function.arguments || "").slice(0, 120);
        return `${tc.function.name}(${args}${(tc.function.arguments || "").length > 120 ? "…" : ""})`;
      })
      .join(", ");
    out += `\n  [TOOL_CALLS] ${calls}`;
  }
  return out;
}

// Some models wrap their entire output in <think> even when the flag asks
// them not to. Stripping the pair would leave an empty summary → context
// loss → the chat loops re-doing work. Defensive extraction:
//   1. If the buffer ends with content AFTER a </think>, use that.
//   2. Otherwise strip paired <think>…</think> blocks.
//   3. Otherwise return the raw buffer (better some context than none).
function extractSummary(buffer: string): string {
  const close = buffer.lastIndexOf("</think>");
  if (close >= 0) {
    const after = buffer.slice(close + "</think>".length).trim();
    if (after) return after;
  }
  const stripped = buffer.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (stripped) return stripped;
  return buffer.trim();
}

async function summarizeMessages(
  api: NonNullable<ReturnType<typeof getApi>>,
  messages: ChatMessage[],
): Promise<string> {
  const transcript = messages.map(formatMessageForSummary).join("\n\n");
  const userMessage =
    `${COMPACT_USER_INSTRUCTIONS}\n\n=== CONVERSATION ===\n${transcript}`;
  let buffer = "";
  const handle = api.chatStream(
    [
      { role: "system", content: COMPACT_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    (chunk) => {
      buffer += chunk;
    },
    { enable_thinking: false, temperature: 0.3 },
  );
  const result = await handle.promise;
  if (!result.ok) throw new Error(result.error);
  return extractSummary(buffer);
}

async function compactHistory(
  api: NonNullable<ReturnType<typeof getApi>>,
  history: ChatMessage[],
): Promise<ChatMessage[]> {
  const recent = history.slice(-KEEP_RECENT_MESSAGES);
  const older = history.slice(0, -KEEP_RECENT_MESSAGES);
  if (older.length === 0) return history;

  const summary = await summarizeMessages(api, older);
  const recap: ChatMessage = {
    role: "user",
    content: `[Résumé compacté de la conversation précédente]\n\n${summary}`,
  };
  return [recap, ...recent];
}
