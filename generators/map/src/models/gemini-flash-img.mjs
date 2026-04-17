/**
 * Gemini 3.1 Flash Image (Nano Banana 2) via OpenRouter.
 * Used for image generation and image editing (text+image → image).
 */

import { logModelCall, logModelResponse, logModelImageResponse, logError } from "../utils/logger.mjs";
import { getMapImageSizeLabel } from "../utils/generation-config.mjs";

const MODEL = "google/gemini-3.1-flash-image-preview";
const DEFAULT_REQUEST_TIMEOUT_MS = parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS || "180000", 10);
const MAX_CONSECUTIVE_FAILURES = 2;

async function withRetry(fn, logStep) {
  for (let attempt = 1; attempt <= MAX_CONSECUTIVE_FAILURES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt < MAX_CONSECUTIVE_FAILURES) {
        console.warn(`[${logStep}] Attempt ${attempt} failed (${e.message}), retrying...`);
        continue;
      }
      throw e;
    }
  }
}

function resolveRequestTimeoutMs(requestTimeoutMs, timeoutEnvKey) {
  if (Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0) {
    return requestTimeoutMs;
  }

  if (timeoutEnvKey && process.env[timeoutEnvKey]) {
    const parsed = parseInt(process.env[timeoutEnvKey], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Text-to-image generation.
 * @returns {Buffer} PNG image buffer
 */
export async function generateImage(
  prompt,
  { aspectRatio = "16:9", imageSize = getMapImageSizeLabel(), logStep = "flash-img-gen", requestTimeoutMs, timeoutEnvKey } = {},
) {
  return withRetry(async () => {
    const API_KEY = process.env.OPENROUTER_API_KEY || "";
    logModelCall(logStep, MODEL, prompt, [`config: aspect=${aspectRatio}, size=${imageSize}`]);
    const timeoutMs = resolveRequestTimeoutMs(requestTimeoutMs, timeoutEnvKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: prompt }],
          modalities: ["image", "text"],
          image_config: { aspect_ratio: aspectRatio, image_size: imageSize },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        const error = new Error(`Flash Image API error ${res.status}: ${err}`);
        logError(logStep, error);
        throw error;
      }

      const data = await res.json();
      const buf = extractImageBuffer(data);
      logModelImageResponse(logStep, MODEL, "(returned to caller)", buf.length);
      return buf;
    } catch (e) {
      if (e.name === "AbortError") {
        const error = new Error(`Flash Image request timed out after ${timeoutMs / 1000}s`);
        logError(logStep, error);
        throw error;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }, logStep);
}

/**
 * Image editing: pass an existing image + text instruction → modified image.
 * @param {string} text  - editing instruction
 * @param {Buffer} imageBuffer - source image
 * @returns {Buffer} PNG image buffer
 */
export async function editImage(text, imageBuffer, { imageSize = "2K", logStep = "flash-img-edit", requestTimeoutMs, timeoutEnvKey } = {}) {
  return withRetry(async () => {
    const API_KEY = process.env.OPENROUTER_API_KEY || "";
    logModelCall(logStep, MODEL, text, [`input_image: ${(imageBuffer.length / 1024).toFixed(0)}KB`, `config: size=${imageSize}`]);
    const timeoutMs = resolveRequestTimeoutMs(requestTimeoutMs, timeoutEnvKey);

    const base64 = imageBuffer.toString("base64");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${base64}` },
                },
              ],
            },
          ],
          modalities: ["image", "text"],
          image_config: { image_size: imageSize },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        const error = new Error(`Flash Image Edit API error ${res.status}: ${err}`);
        logError(logStep, error);
        throw error;
      }

      const data = await res.json();
      const buf = extractImageBuffer(data);
      logModelImageResponse(logStep, MODEL, "(returned to caller)", buf.length);
      return buf;
    } catch (e) {
      if (e.name === "AbortError") {
        const error = new Error(`Flash Image Edit request timed out after ${timeoutMs / 1000}s`);
        logError(logStep, error);
        throw error;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }, logStep);
}

function extractImageBuffer(data) {
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("No message in Flash Image response");

  if (message.images && message.images.length > 0) {
    const url = message.images[0].image_url.url;
    const b64 = url.replace(/^data:image\/\w+;base64,/, "");
    return Buffer.from(b64, "base64");
  }

  if (message.content && typeof message.content === "string") {
    const match = message.content.match(/data:image\/\w+;base64,([A-Za-z0-9+/=]+)/);
    if (match) return Buffer.from(match[1], "base64");
  }

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "image_url") {
        const url = part.image_url?.url || "";
        const b64 = url.replace(/^data:image\/\w+;base64,/, "");
        if (b64) return Buffer.from(b64, "base64");
      }
    }
  }

  throw new Error("No image found in Flash Image response");
}
