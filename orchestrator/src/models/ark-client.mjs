/**
 * Volcengine Ark (ark-code-latest) client — OpenAI-compatible chat completions.
 * Same behavior as generators/map; loads env from world-seed root.
 */

import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  STRUCTURED_OUTPUT_MODES,
  resolveStructuredOutputMode,
  getStructuredOutputAttemptModes,
  isUnsupportedJsonModeError,
  parsePossiblyMalformedJSON,
} from "../../../shared/structured-output.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "../../../.env") });

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
const DEFAULT_MODEL = "ark-code-latest";
const DEFAULT_JSON_RETRIES = parseInt(process.env.ARK_JSON_RETRIES || "3", 10);
const DEFAULT_REQUEST_TIMEOUT_MS = parseInt(process.env.ARK_REQUEST_TIMEOUT_MS || "120000", 10);
const DEFAULT_STRUCTURED_OUTPUT_MODE = resolveStructuredOutputMode(
  undefined,
  process.env.ARK_STRUCTURED_OUTPUT_MODE,
  STRUCTURED_OUTPUT_MODES.PROMPT_ONLY,
);
const structuredOutputCapabilityCache = new Map();

function logModelCall(step, model, promptSummary) {
  console.log(`[${step}] ${model} request:\n${promptSummary.slice(0, 2000)}${promptSummary.length > 2000 ? "…" : ""}`);
}

function logModelResponse(step, model, text) {
  console.log(`[${step}] ${model} response (${text.length} chars)`);
}

function logError(step, error) {
  console.error(`[${step}]`, error);
}

export async function arkChat(messages, { temperature = 0.3, logStep = "ark", requestTimeoutMs, responseFormatType } = {}) {
  const BASE_URL = process.env.ARK_BASE_URL || DEFAULT_BASE_URL;
  const API_KEY = process.env.ARK_API_KEY || "";
  const MODEL = process.env.ARK_MODEL || DEFAULT_MODEL;
  const timeoutMs =
    Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;

  const promptSummary = messages.map((m) => `[${m.role}] ${m.content.slice(0, 500)}`).join("\n");
  logModelCall(logStep, MODEL, promptSummary);

  async function sendRequest() {
    const body = {
      model: MODEL,
      messages,
      temperature,
    };
    if (responseFormatType) {
      body.response_format = { type: responseFormatType };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        const error = new Error(`Ark API error ${res.status}: ${err}`);
        logError(logStep, error);
        throw error;
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? "";
      logModelResponse(logStep, MODEL, text);
      return text;
    } catch (e) {
      if (e.name === "AbortError") {
        const error = new Error(`Ark request timed out after ${timeoutMs / 1000}s`);
        logError(logStep, error);
        throw error;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  return sendRequest();
}

/**
 * JSON-mode chat. Supports either:
 * - arkChatJSON(messages, opts) — same as map generator
 * - arkChatJSON({ systemMessage, userMessage, temperature, logStep }) — orchestrator convenience
 */
export async function arkChatJSON(arg, maybeOpts = {}) {
  let messages;
  let opts = { ...maybeOpts };

  if (Array.isArray(arg)) {
    messages = arg;
  } else {
    const { systemMessage, userMessage, temperature = 0.3, structuredOutputMode, logStep = "ark" } = arg;
    if (systemMessage == null || userMessage == null) {
      throw new Error("arkChatJSON: when using object form, systemMessage and userMessage are required");
    }
    messages = [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage },
    ];
    opts = { ...opts, temperature, structuredOutputMode, logStep };
  }

  let lastError = null;
  const retries = opts.jsonRetries ?? DEFAULT_JSON_RETRIES;
  const structuredOutputMode = resolveStructuredOutputMode(
    opts.structuredOutputMode,
    process.env.ARK_STRUCTURED_OUTPUT_MODE,
    DEFAULT_STRUCTURED_OUTPUT_MODE,
  );
  const baseURL = process.env.ARK_BASE_URL || DEFAULT_BASE_URL;
  const model = process.env.ARK_MODEL || DEFAULT_MODEL;
  const capabilityKey = `${baseURL}::${model}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const attemptModes = getStructuredOutputAttemptModes(
      structuredOutputMode,
      structuredOutputCapabilityCache.get(capabilityKey),
    );

    for (const mode of attemptModes) {
      try {
        const raw = await arkChat(messages, {
          ...opts,
          responseFormatType:
            mode === STRUCTURED_OUTPUT_MODES.JSON_OBJECT ? "json_object" : undefined,
        });
        return parsePossiblyMalformedJSON(raw);
      } catch (error) {
        lastError = error;

        if (
          mode === STRUCTURED_OUTPUT_MODES.JSON_OBJECT &&
          isUnsupportedJsonModeError(error)
        ) {
          structuredOutputCapabilityCache.set(
            capabilityKey,
            STRUCTURED_OUTPUT_MODES.PROMPT_ONLY,
          );
          if (structuredOutputMode === STRUCTURED_OUTPUT_MODES.AUTO) {
            console.warn(
              `[${opts.logStep || "ark"}] json_object unsupported, falling back to prompt-only JSON.`,
            );
            continue;
          }
        }

        if (
          structuredOutputMode === STRUCTURED_OUTPUT_MODES.AUTO &&
          mode === STRUCTURED_OUTPUT_MODES.JSON_OBJECT &&
          attemptModes.includes(STRUCTURED_OUTPUT_MODES.PROMPT_ONLY)
        ) {
          console.warn(
            `[${opts.logStep || "ark"}] structured JSON request failed, retrying with prompt-only JSON.`,
          );
          continue;
        }

        if (attempt < retries) {
          console.warn(
            `[${opts.logStep || "ark"}] JSON parse/request failed on attempt ${attempt}/${retries} (${mode}), retrying...`,
          );
        }
        break;
      }
    }
  }

  throw lastError || new Error("Failed to parse Ark JSON response");
}
