/**
 * Gemini 3.1 Flash Image (Nano Banana 2) via OpenRouter.
 * Simplified client for character sprite generation.
 */

const MODEL = "google/gemini-3.1-flash-image-preview";
const REQUEST_TIMEOUT_MS = parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS || "180000", 10);

/**
 * Image editing: send reference image + text instruction -> new image.
 * @param {string} text  - generation instruction
 * @param {Buffer} imageBuffer - reference sprite sheet
 * @returns {Buffer} PNG image buffer
 */
export async function editImage(text, imageBuffer, { imageSize = "1K" } = {}) {
  const API_KEY = process.env.OPENROUTER_API_KEY || "";
  const base64 = imageBuffer.toString("base64");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
      throw new Error(`Flash Image Edit API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return extractImageBuffer(data);
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`Flash Image Edit request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
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
