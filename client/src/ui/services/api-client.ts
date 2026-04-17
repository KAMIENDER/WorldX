import type {
  CharacterInfo,
  CharacterDetail,
  RelationshipEdge,
  DiaryEntry,
  MemoryEntry,
  SimulationEvent,
  WorldTimeInfo,
  LocationInfo,
  GraphData,
  GameTime,
  MainAreaPointInfo,
  SceneConfigInfo,
  SceneRuntimeInfo,
} from "../../types/api";

const API_BASE = "/api";

async function requestJSON<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.error ? `: ${body.error}` : "";
    } catch {
      // Ignore non-JSON error bodies.
    }
    throw new Error(`API ${res.status}${detail}`);
  }
  return res.json();
}

function fetchJSON<T>(path: string): Promise<T> {
  return requestJSON(path);
}

function postJSON<T>(path: string, body?: unknown): Promise<T> {
  return requestJSON(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function patchJSON<T>(path: string, body?: unknown): Promise<T> {
  return requestJSON(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export interface WorldInfo {
  worldName: string;
  worldDescription: string;
  currentWorldId?: string | null;
  sceneConfig: SceneConfigInfo;
  sceneRuntime: SceneRuntimeInfo;
  mainAreaPoints?: MainAreaPointInfo[];
}

export interface GeneratedWorldSummary {
  id: string;
  worldName: string;
  isCurrent: boolean;
}

export interface GeneratedWorldListResponse {
  currentWorldId: string | null;
  worlds: GeneratedWorldSummary[];
}

export const apiClient = {
  getWorldTime(): Promise<WorldTimeInfo> {
    return fetchJSON("/world/time");
  },

  getWorldInfo(): Promise<WorldInfo> {
    return fetchJSON("/world/info");
  },

  getGeneratedWorlds(): Promise<GeneratedWorldListResponse> {
    return fetchJSON("/world/worlds");
  },

  getLocations(): Promise<LocationInfo[]> {
    return fetchJSON("/world/locations");
  },

  getCharacters(): Promise<CharacterInfo[]> {
    return fetchJSON("/characters");
  },

  getCharacterDetail(id: string): Promise<CharacterDetail> {
    return fetchJSON(`/characters/${id}`);
  },

  getRelationships(id: string): Promise<RelationshipEdge[]> {
    return fetchJSON(`/characters/${id}/relationships`);
  },

  getDiary(id: string, day?: number): Promise<DiaryEntry[]> {
    const q = day != null ? `?day=${day}` : "";
    return fetchJSON(`/characters/${id}/diary${q}`);
  },

  getMemories(id: string): Promise<MemoryEntry[]> {
    return fetchJSON(`/characters/${id}/memories`);
  },

  getEvents(params: {
    fromDay?: number;
    toDay?: number;
    type?: string;
    actorId?: string;
    limit?: number;
    offset?: number;
  }): Promise<SimulationEvent[]> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null) q.set(k, String(v));
    }
    return fetchJSON(`/events?${q}`);
  },

  getEventsByRange(from: GameTime, to: GameTime): Promise<SimulationEvent[]> {
    const q = new URLSearchParams({
      fromDay: String(from.day),
      fromTick: String(from.tick),
      toDay: String(to.day),
      toTick: String(to.tick),
    });
    return fetchJSON(`/events/range?${q}`);
  },

  getHighlights(minScore = 6, limit = 20): Promise<SimulationEvent[]> {
    return fetchJSON(`/events/highlights?minScore=${minScore}&limit=${limit}`);
  },

  getGraph(): Promise<GraphData> {
    return fetchJSON("/graph/current");
  },

  getGraphHistory(day: number): Promise<GraphData> {
    return fetchJSON(`/graph/history/${day}`);
  },

  simulateTick(): Promise<{ ok: boolean; gameTime: WorldTimeInfo; eventCount: number }> {
    return postJSON("/simulation/tick");
  },

  simulateDay(): Promise<{ ok: boolean; gameTime: WorldTimeInfo; eventCount: number }> {
    return postJSON("/simulation/day");
  },

  switchWorld(worldId: string): Promise<{
    ok: boolean;
    currentWorldId: string;
    worldName: string;
  }> {
    return postJSON("/world/select", { worldId });
  },

  resetWorld(): Promise<{ ok: boolean; gameTime: WorldTimeInfo }> {
    return postJSON("/simulation/reset");
  },

  godBroadcast(params: {
    content: string;
    scope?: string;
    tone?: string;
    tags?: string[];
    writeMemory?: boolean;
  }): Promise<{ ok: boolean; event: SimulationEvent; memoryWrittenTo: number }> {
    return postJSON("/god/broadcast", params);
  },

  godWhisper(params: {
    characterId: string;
    content: string;
    importance?: number;
    type?: "observation" | "dream" | "reflection" | "experience";
    tags?: string[];
    emotionalValence?: number;
    emotionalIntensity?: number;
  }): Promise<{ ok: boolean; memory: MemoryEntry }> {
    return postJSON("/god/whisper", params);
  },

  sandboxChatStart(params: {
    characterId: string;
    userIdentity?: string;
  }): Promise<{
    ok: boolean;
    sessionId: string;
    character: { id: string; name: string; mbtiType: string };
  }> {
    return postJSON("/sandbox/chat/start", params);
  },

  sandboxChatSend(params: {
    sessionId: string;
    message: string;
  }): Promise<{
    ok: boolean;
    reply: string;
    character: { id: string; name: string };
  }> {
    return postJSON("/sandbox/chat/message", params);
  },

  sandboxChatGet(sessionId: string): Promise<{
    ok: boolean;
    sessionId: string;
    characterId: string;
    userIdentity: string;
    history: Array<{ role: "user" | "character"; content: string }>;
  }> {
    return fetchJSON(`/sandbox/chat/${sessionId}`);
  },

  sandboxChatClose(sessionId: string): Promise<{ ok: boolean }> {
    return postJSON("/sandbox/chat/close", { sessionId });
  },

  patchCharacterProfile(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<{ ok: boolean; profile: Record<string, unknown> }> {
    return patchJSON(`/characters/${id}/profile`, patch);
  },

  patchCharacterRuntimeState(
    id: string,
    patch: { mainAreaPointId?: string | null },
  ): Promise<{ ok: boolean; state: Record<string, unknown> }> {
    return patchJSON(`/characters/${id}/runtime-state`, patch);
  },
};
