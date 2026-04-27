"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat, type ToolExecutor } from "@/hooks/useChat";
import type { ChatMessage, ToolDefinition } from "@/lib/n2n";

type Props = {
  onClose: () => void;
  systemPrompt: string;
  tools: ToolDefinition[];
  executor: ToolExecutor;
};

type Parsed = { thinking: string; answer: string; thinkingDone: boolean };

function parseAssistant(raw: string): Parsed {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("<think>")) {
    return { thinking: "", answer: raw, thinkingDone: true };
  }
  const start = raw.indexOf("<think>") + "<think>".length;
  const end = raw.indexOf("</think>", start);
  if (end === -1) {
    return { thinking: raw.slice(start), answer: "", thinkingDone: false };
  }
  return {
    thinking: raw.slice(start, end),
    answer: raw.slice(end + "</think>".length).trimStart(),
    thinkingDone: true,
  };
}

const THINKING_STORAGE_KEY = "n2n.thinkingEnabled";

function loadThinkingEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(THINKING_STORAGE_KEY) !== "false";
}

export function ChatPanel({ onClose, systemPrompt, tools, executor }: Props) {
  const [thinkingEnabled, setThinkingEnabled] = useState(loadThinkingEnabled);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      THINKING_STORAGE_KEY,
      thinkingEnabled ? "true" : "false",
    );
  }, [thinkingEnabled]);

  const { messages, send, stop, clear, streaming, error } = useChat({
    systemPrompt,
    tools,
    executor,
    thinkingEnabled,
  });
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!streaming) inputRef.current?.focus();
  }, [streaming]);

  const submit = () => {
    if (!input.trim() || streaming) return;
    send(input);
    setInput("");
  };

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <span className="text-sm font-semibold">IA</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setThinkingEnabled((v) => !v)}
            title={
              thinkingEnabled
                ? "Thinking activé · cliquer pour désactiver"
                : "Thinking désactivé · cliquer pour activer"
            }
            className={[
              "flex h-6 w-6 items-center justify-center rounded transition",
              thinkingEnabled
                ? "bg-purple-100 text-purple-700 hover:bg-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:hover:bg-purple-900/60"
                : "text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800",
            ].join(" ")}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
              {!thinkingEnabled && <path d="M3 21 21 3" />}
            </svg>
          </button>
          <button
            onClick={clear}
            disabled={messages.length === 0 && !streaming}
            title="Vider"
            className="rounded px-2 py-0.5 text-[11px] text-slate-500 transition hover:bg-slate-100 disabled:opacity-30 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            Effacer
          </button>
          <button
            onClick={onClose}
            title="Fermer"
            className="flex h-6 w-6 items-center justify-center rounded text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            ×
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <EmptyHint />
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m, i) => (
              <Bubble
                key={i}
                message={m}
                isLast={i === messages.length - 1}
                streaming={streaming}
              />
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="border-t border-rose-200 bg-rose-50 px-4 py-2 text-[11px] text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex shrink-0 items-end gap-2 border-t border-slate-200 p-3 dark:border-slate-700"
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Écrivez à l'IA…"
          rows={2}
          disabled={streaming}
          className="flex-1 resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder-slate-400 outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950 dark:placeholder-slate-500"
        />
        {streaming ? (
          <button
            type="button"
            onClick={stop}
            title="Arrêter la génération"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-rose-600 text-white transition hover:bg-rose-500 active:scale-95"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden
            >
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            title="Envoyer (Entrée)"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-indigo-600 text-white transition hover:bg-indigo-500 active:scale-95 disabled:bg-slate-300 disabled:hover:bg-slate-300 dark:disabled:bg-slate-700 dark:disabled:hover:bg-slate-700"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </form>
    </aside>
  );
}

function EmptyHint() {
  return (
    <div className="flex h-full items-center justify-center text-center">
      <div className="text-xs text-slate-400 dark:text-slate-500">
        Décrivez ce que vous voulez —<br />
        les modules, les flux, les conditions.
      </div>
    </div>
  );
}

function Bubble({
  message,
  isLast,
  streaming,
}: {
  message: ChatMessage;
  isLast: boolean;
  streaming: boolean;
}) {
  if (message.role === "user") {
    return (
      <div className="animate-fade-in flex justify-end">
        <div className="max-w-[85%] rounded-md bg-indigo-600 px-3 py-2 text-sm whitespace-pre-wrap break-words text-white">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "tool") {
    return <ToolResultBadge content={message.content} />;
  }

  if (message.role === "system") {
    return null;
  }

  const parsed = useMemo(
    () => parseAssistant(message.content),
    [message.content],
  );
  const isStreamingHere = isLast && streaming;
  const showThinking = parsed.thinking || !parsed.thinkingDone;
  const toolCalls = "tool_calls" in message ? message.tool_calls ?? [] : [];
  // Hide the empty answer placeholder when the assistant only emitted
  // tool_calls (no visible text) — otherwise we'd show an empty bubble.
  const showAnswer =
    parsed.answer ||
    (isStreamingHere && parsed.thinkingDone && toolCalls.length === 0);

  return (
    <div className="animate-fade-in flex flex-col items-start gap-1.5">
      {showThinking && (
        <ThinkingBlock
          text={parsed.thinking}
          done={parsed.thinkingDone}
          streaming={isStreamingHere && !parsed.thinkingDone}
        />
      )}
      {showAnswer && (
        <div className="max-w-[85%] rounded-md bg-slate-100 px-3 py-2 text-sm whitespace-pre-wrap break-words text-slate-900 dark:bg-slate-800 dark:text-slate-100">
          {parsed.answer || <TypingDots />}
        </div>
      )}
      {toolCalls.map((tc) => (
        <ToolCallBadge
          key={tc.id}
          name={tc.function.name}
          args={tc.function.arguments}
        />
      ))}
    </div>
  );
}

function ToolCallBadge({ name, args }: { name: string; args: string }) {
  const [expanded, setExpanded] = useState(false);
  let pretty = args;
  try {
    pretty = JSON.stringify(JSON.parse(args), null, 2);
  } catch {}
  return (
    <div className="w-full max-w-[85%] overflow-hidden rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] font-mono font-medium text-amber-800 transition hover:bg-amber-100/60 dark:text-amber-200 dark:hover:bg-amber-900/30"
      >
        <span className="text-amber-600 dark:text-amber-400">→</span>
        <span>{name}</span>
        <span className="ml-auto text-[10px] text-amber-500 dark:text-amber-400">
          {expanded ? "▴" : "▾"}
        </span>
      </button>
      {expanded && (
        <pre className="border-t border-amber-200 bg-white/60 px-3 py-1.5 text-[10px] whitespace-pre-wrap break-words text-amber-900 dark:border-amber-800 dark:bg-amber-950/10 dark:text-amber-100">
          {pretty}
        </pre>
      )}
    </div>
  );
}

function ToolResultBadge({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  let parsed: { ok?: boolean; result?: unknown; error?: string } = {};
  try {
    parsed = JSON.parse(content);
  } catch {}
  const ok = parsed.ok !== false;
  return (
    <div
      className={[
        "w-full max-w-[85%] overflow-hidden rounded-md border",
        ok
          ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30"
          : "border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={[
          "flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] font-mono font-medium transition",
          ok
            ? "text-emerald-800 hover:bg-emerald-100/60 dark:text-emerald-200 dark:hover:bg-emerald-900/30"
            : "text-rose-800 hover:bg-rose-100/60 dark:text-rose-200 dark:hover:bg-rose-900/30",
        ].join(" ")}
      >
        <span>{ok ? "✓" : "✕"}</span>
        <span>{ok ? "résultat" : (parsed.error ?? "erreur")}</span>
        <span className="ml-auto text-[10px] opacity-60">
          {expanded ? "▴" : "▾"}
        </span>
      </button>
      {expanded && (
        <pre className="border-t border-current/20 bg-white/60 px-3 py-1.5 text-[10px] whitespace-pre-wrap break-words dark:bg-black/20">
          {JSON.stringify(parsed.result ?? parsed, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ThinkingBlock({
  text,
  streaming,
}: {
  text: string;
  done: boolean;
  streaming: boolean;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="w-full max-w-[85%] overflow-hidden rounded-md border border-purple-300 bg-purple-50 dark:border-purple-700 dark:bg-purple-950/30">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-medium text-purple-800 transition hover:bg-purple-100/60 dark:text-purple-200 dark:hover:bg-purple-900/30"
      >
        <ThinkingIcon active={streaming} />
        <span>
          {streaming
            ? "Réflexion en cours…"
            : `Réflexion (${text.trim().length} car.)`}
        </span>
        <span className="ml-auto text-[10px] text-purple-500 dark:text-purple-400">
          {expanded ? "▴" : "▾"}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-purple-200 bg-white/60 px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-purple-900/80 italic dark:border-purple-800 dark:bg-purple-950/20 dark:text-purple-100/80">
          {text || (streaming ? <TypingDots /> : null)}
        </div>
      )}
    </div>
  );
}

function ThinkingIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={active ? "animate-pulse" : ""}
    >
      <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
    </svg>
  );
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-0.5">
      <span
        className="animate-typing-dot inline-block h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500"
        style={{ animationDelay: "0s" }}
      />
      <span
        className="animate-typing-dot inline-block h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500"
        style={{ animationDelay: "0.2s" }}
      />
      <span
        className="animate-typing-dot inline-block h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500"
        style={{ animationDelay: "0.4s" }}
      />
    </div>
  );
}
