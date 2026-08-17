/**
 * AI Gateway — Unified AI interface with fallback providers
 * Primary: Workers AI (@cf/moonshotai/moonshot-auto)
 * Fallback: Groq (llama-3.3-70b-versatile)
 */

import type { Env } from "../types";

interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface JsonSchema {
  type: string;
  properties: Record<string, unknown>;
  required?: string[];
}

export interface LlmCallOptions {
  messages: LlmMessage[];
  max_tokens?: number;
  temperature?: number;
  response_format?: {
    type: "json_schema";
    json_schema: {
      name: string;
      schema: JsonSchema;
      strict?: boolean;
    };
  };
}

export interface LlmCallResult {
  response: string;
  provider: "workers-ai" | "groq";
  model: string;
}

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Detect if error is quota/rate-limit related */
function isQuotaError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("quota") ||
      msg.includes("rate limit") ||
      msg.includes("too many requests") ||
      msg.includes("429") ||
      msg.includes("insufficient") ||
      msg.includes("exceeded") ||
      msg.includes("limit") ||
      msg.includes("for mange") ||
      msg.includes("neurons") ||
      msg.includes("daily") ||
      msg.includes("allocation")
    );
  }
  return false;
}

/** Call Workers AI with JSON schema support */
async function callWorkersAI(
  env: Env,
  options: LlmCallOptions
): Promise<LlmCallResult> {
  const result = await env.AI.run(WORKERS_AI_MODEL, {
    messages: options.messages,
    max_tokens: options.max_tokens || 512,
    temperature: options.temperature ?? 0.3,
    response_format: options.response_format,
  });

  // Nyere modeller (llama-3.3-70b-fp8-fast) svarer i OpenAI-format:
  // choices[0].message.content — eldre i Workers AI-format: .response.
  // Bindingen kan også wrappe svaret i {response: {...}} — garanter en string.
  const r = result as {
    response?: unknown;
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = r.response ?? r.choices?.[0]?.message?.content ?? "";
  const response = typeof raw === "string" ? raw : raw ? JSON.stringify(raw) : "";
  if (!response) {
    throw new Error("Empty response from Workers AI");
  }

  return { response, provider: "workers-ai", model: WORKERS_AI_MODEL };
}

/** Call Groq API (OpenAI-compatible) */
async function callGroq(
  apiKey: string,
  options: LlmCallOptions
): Promise<LlmCallResult> {
  // Groq supports json_object response format, not json_schema
  // We inject the schema into the system prompt instead
  const hasSchema =
    options.response_format?.json_schema?.schema;

  let messages = [...options.messages];

  // If we have a JSON schema, inject it into system prompt for Groq
  if (hasSchema && messages[0]?.role === "system") {
    const schema = options.response_format!.json_schema.schema;
    messages = [
      {
        role: "system",
        content:
          messages[0].content +
          `

VIKTIG: Du MÅ returnere et gyldig JSON-objekt som strengt følger dette skjemaet:
${JSON.stringify(schema, null, 2)}

Returner KUN JSON, ingen annen tekst før eller etter.`,
      },
      ...messages.slice(1),
    ];
  }

  const body = {
    model: GROQ_MODEL,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    max_tokens: options.max_tokens || 512,
    temperature: options.temperature ?? 0.3,
    response_format: hasSchema ? { type: "json_object" } : undefined,
  };

  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(
      `Groq API error: ${res.status} ${res.statusText} — ${errText.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(`Groq API error: ${data.error.message || "Unknown"}`);
  }

  const response = data.choices?.[0]?.message?.content || "";
  if (!response) {
    throw new Error("Empty response from Groq");
  }

  return { response, provider: "groq", model: GROQ_MODEL };
}

/**
 * Unified LLM call with automatic fallback
 * 1. Try Workers AI first (fast, cheap, schema support)
 * 2. If quota exhausted → Groq fallback
 * 3. If Groq fails too → throw error
 */
export async function callLLM(
  env: Env,
  options: LlmCallOptions
): Promise<LlmCallResult> {
  // Try Workers AI first
  try {
    const result = await callWorkersAI(env, options);
    console.log(`[AI-Gateway] Workers AI succeeded (${result.model})`);
    return result;
  } catch (error) {
    const isQuota = isQuotaError(error);
    console.warn(
      `[AI-Gateway] Workers AI failed${isQuota ? " (quota)" : ""}:`,
      error instanceof Error ? error.message : String(error)
    );

    // If Groq key is available, try fallback
    if (env.GROQ_API_KEY) {
      console.log(`[AI-Gateway] Falling back to Groq (${GROQ_MODEL})...`);
      try {
        const result = await callGroq(env.GROQ_API_KEY, options);
        console.log(`[AI-Gateway] Groq fallback succeeded`);
        return result;
      } catch (groqError) {
        console.error(
          `[AI-Gateway] Groq fallback failed:`,
          groqError instanceof Error ? groqError.message : String(groqError)
        );
        throw groqError;
      }
    }

    // No fallback available
    throw error;
  }
}

/**
 * Check if AI services are available
 * Returns status for both primary and fallback
 */
export async function checkAIStatus(env: Env): Promise<{
  workersAI: "ok" | "quota_exhausted" | "error";
  groq: "ok" | "no_key" | "error";
  recommended: "workers-ai" | "groq" | "none";
}> {
  let workersAI: "ok" | "quota_exhausted" | "error" = "ok";
  let groq: "ok" | "no_key" | "error" = env.GROQ_API_KEY ? "ok" : "no_key";

  // Quick Workers AI health check (minimal prompt)
  try {
    await env.AI.run(WORKERS_AI_MODEL, {
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 10,
    });
  } catch (e) {
    workersAI = isQuotaError(e) ? "quota_exhausted" : "error";
  }

  // Quick Groq health check
  if (env.GROQ_API_KEY && groq === "ok") {
    try {
      await callGroq(env.GROQ_API_KEY, {
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 10,
      });
    } catch {
      groq = "error";
    }
  }

  const recommended =
    workersAI === "ok"
      ? "workers-ai"
      : groq === "ok"
        ? "groq"
        : "none";

  return { workersAI, groq, recommended };
}
