import type { MemoryEntry, MemoryType, GameTime } from "../types/index.js";
import type { LLMClient } from "../llm/llm-client.js";
import { EmbeddingClient } from "../llm/embedding-client.js";
import * as memoryStore from "../store/memory-store.js";
import { generateId } from "../utils/id-generator.js";
import { absoluteTick } from "../utils/time-helpers.js";

interface RetrievalWeights {
  relevance: number;
  recency: number;
  importance: number;
  emotionalIntensity: number;
}

const DEFAULT_WEIGHTS: RetrievalWeights = {
  relevance: 3,
  recency: 2,
  importance: 2,
  emotionalIntensity: 1,
};

const BM25_K1 = 1.4;
const BM25_B = 0.75;
const DEFAULT_BM25_WEIGHT = 0.45;
const DEFAULT_EMBEDDING_WEIGHT = 0.45;
const DEFAULT_EMBEDDING_BACKFILL_LIMIT = 64;

interface RetrievalParams {
  characterId: string;
  currentTime: GameTime;
  contextKeywords: string[];
  relatedCharacterIds?: string[];
  relatedLocation?: string;
  topK?: number;
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = lower.match(/[a-z0-9_]+/g) ?? [];
  const cjkChars: string[] = lower.match(/\p{Script=Han}/gu) ?? [];

  for (const char of cjkChars) {
    tokens.push(char);
  }
  for (let i = 0; i < cjkChars.length - 1; i++) {
    tokens.push(`${cjkChars[i]}${cjkChars[i + 1]}`);
  }

  return tokens.filter(Boolean);
}

export class MemoryManager {
  private weights: RetrievalWeights;
  private cache = new Map<string, MemoryEntry[]>();
  private embeddingClient: EmbeddingClient | null = null;
  private embeddingQueue: Promise<void> = Promise.resolve();

  constructor(weights?: Partial<RetrievalWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  setLLMClient(_client: LLMClient): void {
    this.embeddingClient = new EmbeddingClient();
  }

  clearCache(): void {
    this.cache.clear();
  }

  addMemory(params: {
    characterId: string;
    type: MemoryType;
    content: string;
    gameTime: GameTime;
    importance: number;
    emotionalValence: number;
    emotionalIntensity: number;
    relatedCharacters?: string[];
    relatedLocation?: string;
    relatedObjects?: string[];
    tags?: string[];
    embedding?: number[];
  }): MemoryEntry {
    const memory: MemoryEntry = {
      id: generateId(),
      characterId: params.characterId,
      type: params.type,
      content: params.content,
      gameDay: params.gameTime.day,
      gameTick: params.gameTime.tick,
      importance: params.importance,
      emotionalValence: params.emotionalValence,
      emotionalIntensity: params.emotionalIntensity,
      relatedCharacters: params.relatedCharacters ?? [],
      relatedLocation: params.relatedLocation ?? "",
      relatedObjects: params.relatedObjects ?? [],
      tags: params.tags ?? [],
      decayFactor: 1.0,
      accessCount: 0,
      isLongTerm: false,
      embedding: params.embedding,
    };

    memoryStore.insertMemory(memory);
    this.cache.delete(params.characterId);
    this.queueEmbedding(memory);
    return memory;
  }

  retrieveMemories(params: RetrievalParams): MemoryEntry[] {
    return this.rankMemories(params).map((s) => s.memory);
  }

  async retrieveMemoriesAsync(params: RetrievalParams): Promise<MemoryEntry[]> {
    const allMemories = this.getFromCache(params.characterId);
    if (allMemories.length === 0) return [];

    const embeddingScores = await this.computeEmbeddingScores(params, allMemories);
    return this.rankMemories(params, embeddingScores).map((s) => s.memory);
  }

  private rankMemories(
    params: RetrievalParams,
    embeddingScores?: Map<string, number>,
  ): Array<{ memory: MemoryEntry; score: number }> {
    const topK = params.topK ?? 10;
    const allMemories = this.getFromCache(params.characterId);

    if (allMemories.length === 0) return [];

    const currentTotalTicks = absoluteTick(params.currentTime);
    const contextLower = params.contextKeywords.map((k) => k.toLowerCase());
    const bm25Scores = this.computeBm25Scores(allMemories, contextLower);
    const hasEmbeddingScores = !!embeddingScores && embeddingScores.size > 0;

    const scored = allMemories.map((memory) => {
      const score = this.computeScore(
        memory,
        currentTotalTicks,
        bm25Scores.get(memory.id) ?? 0,
        embeddingScores?.get(memory.id) ?? 0,
        hasEmbeddingScores,
        params.relatedCharacterIds,
        params.relatedLocation,
      );

      return { memory, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const results = scored.slice(0, topK).map((s) => s.memory);

    for (const m of results) {
      memoryStore.updateMemory(m.id, { accessCount: m.accessCount + 1 });
    }

    return scored.slice(0, topK);
  }

  processMemoryDecay(characterId: string, currentDay: number): void {
    const memories = memoryStore.getMemoriesByCharacter(characterId, {
      isLongTerm: false,
    });

    for (const m of memories) {
      const ageInDays = currentDay - m.gameDay;
      const effectiveStrength =
        m.importance * m.decayFactor + m.accessCount * 0.5;

      if (m.decayFactor < 0.1 && ageInDays > 7) {
        memoryStore.deleteMemory(m.id);
      } else if (m.decayFactor < 0.3 && ageInDays > 3) {
        memoryStore.updateMemory(m.id, {
          tags: [...m.tags.filter((t) => t !== "faded"), "faded"],
        });
      } else if (effectiveStrength < 3 && ageInDays > 5) {
        memoryStore.updateMemory(m.id, {
          tags: [...m.tags.filter((t) => t !== "faded"), "faded"],
        });
      }
    }

    this.cache.delete(characterId);
  }

  processMemoryConsolidation(characterId: string): void {
    const shortTermMemories = memoryStore.getMemoriesByCharacter(characterId, {
      isLongTerm: false,
    });

    for (const m of shortTermMemories) {
      if (m.tags.includes("faded")) continue;

      if (m.importance >= 6 || m.accessCount >= 3) {
        memoryStore.updateMemory(m.id, { isLongTerm: true });
      }
    }
  }

  getRecentMemories(characterId: string, limit: number): MemoryEntry[] {
    return memoryStore.getMemoriesByCharacter(characterId, { limit });
  }

  getRecentHearsay(characterId: string, currentDay: number, dayWindow: number = 3): MemoryEntry[] {
    const minDay = Math.max(1, currentDay - dayWindow + 1);
    return memoryStore
      .getMemoriesByCharacter(characterId, { types: ["hearsay"] })
      .filter((m) => m.gameDay >= minDay);
  }

  getMemoriesByDay(characterId: string, gameDay: number): MemoryEntry[] {
    return memoryStore
      .getMemoriesByCharacter(characterId)
      .filter((m) => m.gameDay === gameDay);
  }

  getMemorySummaryForPrompt(
    characterId: string,
    currentTime: GameTime,
    topK?: number,
  ): string {
    const memories = this.retrieveMemories({
      characterId,
      currentTime,
      contextKeywords: [],
      topK: topK ?? 5,
    });

    if (memories.length === 0) return "（暂无相关记忆）";

    return memories
      .map((m) => {
        const prefix = m.isLongTerm ? "【深刻】" : "";
        return `- ${prefix}${m.content}`;
      })
      .join("\n");
  }

  private getFromCache(characterId: string): MemoryEntry[] {
    let cached = this.cache.get(characterId);
    if (!cached) {
      cached = memoryStore.getMemoriesByCharacter(characterId);
      this.cache.set(characterId, cached);
    }
    return cached;
  }

  private computeScore(
    memory: MemoryEntry,
    currentTotalTicks: number,
    bm25Score: number,
    embeddingScore: number,
    hasEmbeddingScores: boolean,
    relatedCharacterIds?: string[],
    relatedLocation?: string,
  ): number {
    const relevance = this.computeRelevance(
      memory,
      bm25Score,
      embeddingScore,
      hasEmbeddingScores,
      relatedCharacterIds,
      relatedLocation,
    );

    const memoryTotalTicks = absoluteTick({
      day: memory.gameDay,
      tick: memory.gameTick,
    });
    const deltaTicks = Math.max(0, currentTotalTicks - memoryTotalTicks);
    const recency = 1 / (1 + 0.05 * deltaTicks);

    const importance = memory.importance / 10;
    const emotionalIntensity = memory.emotionalIntensity / 10;

    return (
      this.weights.relevance * relevance +
      this.weights.recency * recency +
      this.weights.importance * importance +
      this.weights.emotionalIntensity * emotionalIntensity
    );
  }

  private computeRelevance(
    memory: MemoryEntry,
    bm25Score: number,
    embeddingScore: number,
    hasEmbeddingScores: boolean,
    relatedCharacterIds?: string[],
    relatedLocation?: string,
  ): number {
    const bm25Weight = getNumberEnv("MEMORY_BM25_WEIGHT", DEFAULT_BM25_WEIGHT);
    const embeddingWeight = hasEmbeddingScores
      ? getNumberEnv("MEMORY_EMBEDDING_WEIGHT", DEFAULT_EMBEDDING_WEIGHT)
      : 0;
    const totalTextWeight = Math.max(0.0001, bm25Weight + embeddingWeight);

    let bonus = 0;
    if (
      relatedCharacterIds &&
      memory.relatedCharacters.some((c) => relatedCharacterIds.includes(c))
    ) {
      bonus += 0.3;
    }
    if (relatedLocation && memory.relatedLocation === relatedLocation) {
      bonus += 0.2;
    }

    return Math.min(
      1,
      ((bm25Score * bm25Weight) + (embeddingScore * embeddingWeight)) / totalTextWeight +
        bonus,
    );
  }

  private computeBm25Scores(
    memories: MemoryEntry[],
    contextLower: string[],
  ): Map<string, number> {
    const scores = new Map<string, number>();
    const queryTokens = tokenize(contextLower.join(" "));
    if (queryTokens.length === 0 || memories.length === 0) return scores;

    const queryTerms = Array.from(new Set(queryTokens));
    const docs = memories.map((memory) => {
      const tokens = tokenize(memoryTextForRetrieval(memory));
      const termFrequency = new Map<string, number>();
      for (const token of tokens) {
        termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
      }
      return { memory, tokens, termFrequency };
    });
    const avgDocLength =
      docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / Math.max(1, docs.length);

    const documentFrequency = new Map<string, number>();
    for (const term of queryTerms) {
      let count = 0;
      for (const doc of docs) {
        if (doc.termFrequency.has(term)) count++;
      }
      documentFrequency.set(term, count);
    }

    let maxScore = 0;
    for (const doc of docs) {
      let rawScore = 0;
      const docLength = Math.max(1, doc.tokens.length);
      for (const term of queryTerms) {
        const tf = doc.termFrequency.get(term) ?? 0;
        if (tf === 0) continue;

        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
        rawScore +=
          idf *
          ((tf * (BM25_K1 + 1)) /
            (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgDocLength))));
      }
      scores.set(doc.memory.id, rawScore);
      maxScore = Math.max(maxScore, rawScore);
    }

    if (maxScore <= 0) return scores;
    for (const [memoryId, rawScore] of scores.entries()) {
      scores.set(memoryId, rawScore / maxScore);
    }

    return scores;
  }

  private async computeEmbeddingScores(
    params: RetrievalParams,
    memories: MemoryEntry[],
  ): Promise<Map<string, number> | undefined> {
    const client = this.embeddingClient;
    const queryText = params.contextKeywords.join(" ").trim();
    if (!client?.isConfigured() || !queryText) return undefined;

    try {
      const queryEmbedding = await client.embedText(queryText);
      await this.ensureMemoryEmbeddings(memories, queryEmbedding.length);

      const scores = new Map<string, number>();
      for (const memory of memories) {
        if (!memory.embedding || memory.embedding.length !== queryEmbedding.length) continue;
        scores.set(memory.id, Math.max(0, cosineSimilarity(queryEmbedding, memory.embedding)));
      }
      return scores;
    } catch (err) {
      console.warn(
        "[MemoryManager] Embedding retrieval unavailable, falling back to BM25:",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  private async ensureMemoryEmbeddings(memories: MemoryEntry[], expectedDimensions: number): Promise<void> {
    const client = this.embeddingClient;
    if (!client?.isConfigured()) return;

    const backfillLimit = getNumberEnv(
      "EMBEDDING_BACKFILL_LIMIT",
      DEFAULT_EMBEDDING_BACKFILL_LIMIT,
    );
    const missing = memories
      .filter((memory) => !memory.embedding || memory.embedding.length !== expectedDimensions)
      .sort((a, b) => b.importance - a.importance || b.gameDay - a.gameDay || b.gameTick - a.gameTick)
      .slice(0, Math.max(0, Math.floor(backfillLimit)));

    for (let i = 0; i < missing.length; i += client.getBatchSize()) {
      const batch = missing.slice(i, i + client.getBatchSize());
      if (batch.length === 0) continue;

      const embeddings = await client.embedTexts(batch.map(memoryTextForEmbedding));
      for (let j = 0; j < batch.length; j++) {
        const memory = batch[j];
        const embedding = embeddings[j];
        memory.embedding = embedding;
        memoryStore.updateMemory(memory.id, { embedding });
      }
    }
  }

  private queueEmbedding(memory: MemoryEntry): void {
    const client = this.embeddingClient;
    if (!client?.isConfigured()) return;

    this.embeddingQueue = this.embeddingQueue
      .catch(() => undefined)
      .then(async () => {
        const embedding = await client.embedText(memoryTextForEmbedding(memory));
        memory.embedding = embedding;
        memoryStore.updateMemory(memory.id, { embedding });
        this.cache.delete(memory.characterId);
      })
      .catch((err) => {
        console.warn(
          `[MemoryManager] Failed to embed memory ${memory.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
  }
}

function memoryTextForRetrieval(memory: MemoryEntry): string {
  return [
    memory.content,
    ...memory.tags,
    ...memory.relatedCharacters,
    memory.relatedLocation,
    ...memory.relatedObjects,
  ].join(" ");
}

function memoryTextForEmbedding(memory: MemoryEntry): string {
  return [
    memory.type,
    memory.content,
    memory.relatedLocation ? `地点：${memory.relatedLocation}` : "",
    memory.relatedCharacters.length > 0 ? `相关角色：${memory.relatedCharacters.join(", ")}` : "",
    memory.tags.length > 0 ? `标签：${memory.tags.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function getNumberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}
