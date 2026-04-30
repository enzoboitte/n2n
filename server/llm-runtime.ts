// Multi-provider LLM client for the `llm-chat` module. Two adapters:
//
//   - OpenAI Chat Completions (covers OpenAI, OpenRouter, Mistral, Groq,
//     DeepSeek, xAI, Together, Ollama, llama.cpp, and any compatible
//     backend via a custom base_url).
//   - Anthropic Messages API.
//   - Google Gemini API (generateContent).
//
// Input shapes accepted as `prompt`:
//   - a plain string                  → user message
//   - an array of { role, content }   → passed through as messages
//   - anything else                   → JSON.stringify'd as user message

import type { RunResult } from "./graph-types.ts";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const OPENAI_COMPATIBLE_DEFAULTS: Record<string, string> = {
  openai:      "https://api.openai.com/v1",
  openrouter:  "https://openrouter.ai/api/v1",
  mistral:     "https://api.mistral.ai/v1",
  groq:        "https://api.groq.com/openai/v1",
  deepseek:    "https://api.deepseek.com/v1",
  xai:         "https://api.x.ai/v1",
  together:    "https://api.together.xyz/v1",
  ollama:      "http://localhost:11434/v1",
  "llama-cpp": "http://localhost:8080/v1",
};

function normalizeMessages(input: unknown, system: string, fallbackPrompt: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  if (Array.isArray(input)) {
    for (const m of input) {
      if (!m || typeof m !== "object") continue;
      const role = String((m as any).role ?? "user");
      const content = String((m as any).content ?? "");
      if (role === "system" || role === "user" || role === "assistant") {
        out.push({ role, content });
      }
    }
    if (out.filter((m) => m.role !== "system").length > 0) return out;
    // fall through to fallback prompt if the array had no usable entries
  }
  const promptText =
    typeof input === "string" && input
      ? input
      : input !== null && input !== undefined && typeof input !== "object"
        ? String(input)
        : input && typeof input === "object" && !Array.isArray(input)
          ? JSON.stringify(input)
          : fallbackPrompt;
  if (promptText) out.push({ role: "user", content: promptText });
  return out;
}

async function callOpenAICompat(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}): Promise<RunResult> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), args.timeoutMs);
  try {
    const resp = await fetch(`${args.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        ...(args.apiKey ? { "Authorization": `Bearer ${args.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: args.model,
        messages: args.messages,
        temperature: args.temperature,
        max_tokens: args.maxTokens,
      }),
    });
    const raw = await resp.json().catch(() => null);
    if (!resp.ok) {
      return { ok: false, error: `llm-chat (${resp.status}): ${JSON.stringify(raw)}` };
    }
    const text = (raw as any)?.choices?.[0]?.message?.content ?? "";
    const usage = (raw as any)?.usage ?? null;
    return {
      ok: true,
      outputs: {
        text: String(text || ""),
        usage: usage
          ? { prompt: usage.prompt_tokens, completion: usage.completion_tokens, total: usage.total_tokens }
          : null,
        raw,
      },
    };
  } catch (e: any) {
    return { ok: false, error: `llm-chat fetch: ${e?.message || e}` };
  } finally {
    clearTimeout(t);
  }
}

async function callAnthropic(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}): Promise<RunResult> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), args.timeoutMs);
  try {
    // Anthropic separates system from messages, and only accepts user/
    // assistant in the messages array.
    const system = args.messages.find((m) => m.role === "system")?.content ?? "";
    const msgs = args.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));
    const url = `${args.baseUrl.replace(/\/+$/, "")}/messages`;
    const resp = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": args.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: args.model,
        system: system || undefined,
        messages: msgs,
        max_tokens: args.maxTokens,
        temperature: args.temperature,
      }),
    });
    const raw = await resp.json().catch(() => null);
    if (!resp.ok) {
      return { ok: false, error: `llm-chat anthropic (${resp.status}): ${JSON.stringify(raw)}` };
    }
    const text = Array.isArray((raw as any)?.content)
      ? (raw as any).content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n")
      : "";
    const usage = (raw as any)?.usage ?? null;
    return {
      ok: true,
      outputs: {
        text,
        usage: usage
          ? { prompt: usage.input_tokens, completion: usage.output_tokens, total: (usage.input_tokens || 0) + (usage.output_tokens || 0) }
          : null,
        raw,
      },
    };
  } catch (e: any) {
    return { ok: false, error: `llm-chat anthropic fetch: ${e?.message || e}` };
  } finally {
    clearTimeout(t);
  }
}

async function callGemini(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}): Promise<RunResult> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), args.timeoutMs);
  try {
    // Gemini uses contents (parts: [{text}]) and a separate
    // systemInstruction. Roles are "user" / "model".
    const system = args.messages.find((m) => m.role === "system")?.content ?? "";
    const contents = args.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const base = (args.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const url = `${base}/models/${encodeURIComponent(args.model)}:generateContent?key=${encodeURIComponent(args.apiKey)}`;
    const resp = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: {
          temperature: args.temperature,
          maxOutputTokens: args.maxTokens,
        },
      }),
    });
    const raw = await resp.json().catch(() => null);
    if (!resp.ok) {
      return { ok: false, error: `llm-chat gemini (${resp.status}): ${JSON.stringify(raw)}` };
    }
    const cand = (raw as any)?.candidates?.[0];
    const text = (cand?.content?.parts ?? [])
      .map((p: any) => p?.text ?? "")
      .join("");
    const usage = (raw as any)?.usageMetadata ?? null;
    return {
      ok: true,
      outputs: {
        text,
        usage: usage
          ? { prompt: usage.promptTokenCount, completion: usage.candidatesTokenCount, total: usage.totalTokenCount }
          : null,
        raw,
      },
    };
  } catch (e: any) {
    return { ok: false, error: `llm-chat gemini fetch: ${e?.message || e}` };
  } finally {
    clearTimeout(t);
  }
}

export async function runLlmChat(
  inputs: Record<string, unknown>,
  substituted: Record<string, unknown>,
  env: Record<string, string>,
): Promise<RunResult> {
  const provider = String(substituted.provider || "openai");
  const model = String(substituted.model || "").trim();
  if (!model) return { ok: false, error: "llm-chat: model requis" };

  const apiKeyVar = String(substituted.api_key_env || "").trim();
  const apiKey = apiKeyVar ? String(env[apiKeyVar] ?? "") : "";

  const explicitBase = String(substituted.base_url || "").trim();
  const baseUrl = explicitBase || OPENAI_COMPATIBLE_DEFAULTS[provider] || "";

  const system = String(substituted.system || "");
  const fallbackPrompt = String(substituted.prompt || "");
  const messages = normalizeMessages(inputs.prompt, system, fallbackPrompt);
  if (messages.filter((m) => m.role !== "system").length === 0) {
    return { ok: false, error: "llm-chat: prompt vide (input ou param)" };
  }

  const temperature = Number(substituted.temperature ?? 0.7);
  const maxTokens = Math.max(1, parseInt(String(substituted.max_tokens ?? 1024), 10) || 1024);
  const timeoutMs = Math.max(1000, parseInt(String(substituted.timeout_ms ?? 60_000), 10) || 60_000);

  const common = { apiKey, model, messages, temperature, maxTokens, timeoutMs };

  if (provider === "anthropic") {
    return callAnthropic({ baseUrl: baseUrl || "https://api.anthropic.com/v1", ...common });
  }
  if (provider === "google") {
    return callGemini({ baseUrl: baseUrl || "https://generativelanguage.googleapis.com/v1beta", ...common });
  }
  if (!baseUrl && provider !== "custom") {
    return { ok: false, error: `llm-chat: provider "${provider}" inconnu` };
  }
  if (!baseUrl) {
    return { ok: false, error: "llm-chat: base_url requis pour provider \"custom\"" };
  }
  return callOpenAICompat({ baseUrl, ...common });
}
