const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 800;

export class EmbeddingClient {
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private timeoutMs: number;
  private batchSize: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private disabled: boolean;

  constructor() {
    this.baseURL = (
      process.env.EMBEDDING_BASE_URL ||
      process.env.SIMULATION_BASE_URL ||
      ""
    ).replace(/\/+$/, "");
    this.apiKey = process.env.EMBEDDING_API_KEY || process.env.SIMULATION_API_KEY || "";
    this.model = process.env.EMBEDDING_MODEL || "";
    this.timeoutMs = parsePositiveInt(process.env.EMBEDDING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.batchSize = parsePositiveInt(process.env.EMBEDDING_BATCH_SIZE, DEFAULT_BATCH_SIZE);
    this.maxRetries = parseNonNegativeInt(process.env.EMBEDDING_MAX_RETRIES, DEFAULT_MAX_RETRIES);
    this.retryDelayMs = parsePositiveInt(
      process.env.EMBEDDING_RETRY_DELAY_MS,
      DEFAULT_RETRY_DELAY_MS,
    );
    this.disabled = process.env.EMBEDDING_ENABLED === "0" || process.env.EMBEDDING_ENABLED === "false";
  }

  isConfigured(): boolean {
    return !this.disabled && !!this.baseURL && !!this.apiKey && !!this.model;
  }

  getBatchSize(): number {
    return this.batchSize;
  }

  async embedText(text: string): Promise<number[]> {
    const [embedding] = await this.embedTexts([text]);
    if (!embedding) throw new Error("Embedding API returned no embedding");
    return embedding;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (!this.isConfigured()) {
      throw new Error("Embedding model is not configured");
    }

    const cleanTexts = texts.map((text) => text.trim());
    if (cleanTexts.some((text) => text.length === 0)) {
      throw new Error("Embedding input cannot be empty");
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.fetchEmbeddings(cleanTexts);
      } catch (err) {
        if (attempt >= this.maxRetries || !isRetryableEmbeddingError(err)) {
          throw err;
        }
        await sleep(this.retryDelayMs * (attempt + 1));
      }
    }

    throw new Error("Embedding request failed");
  }

  private async fetchEmbeddings(cleanTexts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseURL}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: cleanTexts.length === 1 ? cleanTexts[0] : cleanTexts,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new EmbeddingHttpError(res.status, errBody);
      }

      const data = (await res.json()) as {
        data?: Array<{ index?: number; embedding?: number[] }>;
      };
      const embeddings = data.data ?? [];
      if (embeddings.length !== cleanTexts.length) {
        throw new Error(
          `Embedding API returned ${embeddings.length} embedding(s), expected ${cleanTexts.length}`,
        );
      }

      return embeddings
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((item) => {
          if (!Array.isArray(item.embedding)) {
            throw new Error("Embedding API response item has no embedding vector");
          }
          return item.embedding;
        });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new EmbeddingTimeoutError(this.timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class EmbeddingHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Embedding API error ${status}: ${body}`);
  }
}

class EmbeddingTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Embedding request timed out after ${timeoutMs}ms`);
  }
}

function isRetryableEmbeddingError(err: unknown): boolean {
  if (err instanceof EmbeddingTimeoutError) return true;
  if (err instanceof EmbeddingHttpError) {
    return err.status === 429 || err.status >= 500;
  }
  return false;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
