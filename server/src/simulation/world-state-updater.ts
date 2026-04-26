import type { CharacterManager } from "../core/character-manager.js";
import type { WorldManager } from "../core/world-manager.js";
import type { LLMClient } from "../llm/llm-client.js";
import type { PromptBuilder } from "../llm/prompt-builder.js";
import { WorldStatePatchSchema, type WorldStatePatchOutput } from "../llm/output-schemas.js";
import type { GameTime, SimulationEvent } from "../types/index.js";
import { generateId } from "../utils/id-generator.js";
import { tickToSceneTimeWithPeriod } from "../utils/time-helpers.js";

const DEFAULT_MAX_EVENTS = 12;
const DEFAULT_TIMEOUT_MS = 30_000;
const RESERVED_GLOBAL_KEYS = new Set(["current_day", "current_tick", "current_day_start_time"]);
const RESERVED_GLOBAL_PREFIXES = ["dialogue_session:"];

export interface RuntimeObjectInfo {
  id: string;
  name: string;
  locationId: string;
  locationName: string;
  state: string;
  stateDescription: string;
  knownStates: string[];
}

interface AppliedObjectUpdate {
  objectId: string;
  objectName: string;
  locationId: string;
  locationName: string;
  previousState: string;
  state: string;
  previousStateDescription: string;
  stateDescription: string;
  reason?: string;
}

interface AppliedWorldStateUpdate {
  key: string;
  previousValue: string | null;
  value: string;
  reason?: string;
}

export interface WorldStateUpdateSnapshot {
  gameTime: GameTime;
  sourceEvents: SimulationEvent[];
  objects: RuntimeObjectInfo[];
  worldName: string;
  worldDescription: string;
  worldState: { key: string; value: string }[];
}

export class WorldStateUpdater {
  constructor(
    private llmClient: LLMClient,
    private promptBuilder: PromptBuilder,
    private worldManager: WorldManager,
    private characterManager: CharacterManager,
  ) {}

  async updateFromEvents(
    events: SimulationEvent[],
    gameTime: GameTime,
  ): Promise<SimulationEvent[]> {
    const snapshot = this.createSnapshot(events, gameTime);
    return snapshot ? this.updateFromSnapshot(snapshot) : [];
  }

  createSnapshot(
    events: SimulationEvent[],
    gameTime: GameTime,
  ): WorldStateUpdateSnapshot | null {
    if (!isWorldStateUpdaterEnabled()) return null;

    const sourceEvents = events
      .filter((event) => event.type !== "world_state_change")
      .slice(-getPositiveIntEnv("WORLD_STATE_UPDATE_MAX_EVENTS", DEFAULT_MAX_EVENTS));
    if (sourceEvents.length === 0) return null;

    const objects = this.getRuntimeObjects();
    if (objects.length === 0) return null;

    return {
      gameTime: { ...gameTime },
      sourceEvents: sourceEvents.map(cloneSimulationEvent),
      objects: objects.map((object) => ({
        ...object,
        knownStates: [...object.knownStates],
      })),
      worldName: this.worldManager.getWorldName(),
      worldDescription: this.worldManager.getWorldDescription(),
      worldState: this.worldManager.getAllGlobalState().map((state) => ({ ...state })),
    };
  }

  async updateFromSnapshot(
    snapshot: WorldStateUpdateSnapshot,
  ): Promise<SimulationEvent[]> {
    try {
      const result = await this.llmClient.call({
        messages: this.promptBuilder.buildWorldStateUpdateMessages({
          day: snapshot.gameTime.day,
          timeString: tickToSceneTimeWithPeriod(snapshot.gameTime.tick),
          worldName: snapshot.worldName,
          worldDescription: snapshot.worldDescription,
          eventSummary: this.formatEventSummary(snapshot.sourceEvents),
          objectStateBlock: formatObjectStateBlock(snapshot.objects),
          worldStateBlock: formatWorldStateBlock(snapshot.worldState),
        }),
        schema: WorldStatePatchSchema,
        options: {
          taskType: "world_state_update",
          temperature: 0.2,
          maxRetries: 1,
          timeoutMs: getPositiveIntEnv("WORLD_STATE_UPDATE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
        },
      });

      const event = this.applyPatch(result.data, snapshot.objects, snapshot.gameTime);
      return event ? [event] : [];
    } catch (err) {
      console.warn(
        "[WorldStateUpdater] Failed to update world state:",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  private applyPatch(
    patch: Partial<WorldStatePatchOutput>,
    objects: RuntimeObjectInfo[],
    gameTime: GameTime,
  ): SimulationEvent | null {
    const objectIndex = new Map(objects.map((object) => [object.id, object]));
    const objectUpdates: AppliedObjectUpdate[] = [];
    const worldStateUpdates: AppliedWorldStateUpdate[] = [];

    for (const update of patch.objectUpdates ?? []) {
      const objectId = update.objectId.trim();
      const object = objectIndex.get(objectId);
      if (!object) continue;

      const nextState = normalizeStateKey(update.state) ?? object.state;
      const nextDescription =
        typeof update.stateDescription === "string"
          ? clampText(update.stateDescription, 180)
          : object.stateDescription;

      if (nextState === object.state && nextDescription === object.stateDescription) {
        continue;
      }

      this.worldManager.updateObjectState(object.id, nextState, nextDescription);
      objectUpdates.push({
        objectId: object.id,
        objectName: object.name,
        locationId: object.locationId,
        locationName: object.locationName,
        previousState: object.state,
        state: nextState,
        previousStateDescription: object.stateDescription,
        stateDescription: nextDescription,
        reason: clampOptionalText(update.reason, 160),
      });
    }

    for (const update of patch.worldStateUpdates ?? []) {
      const key = update.key.trim();
      const value = clampText(update.value, 160);
      if (!isAllowedGlobalKey(key) || !value) continue;

      const previousValue = this.worldManager.getGlobal(key);
      if (previousValue === value) continue;

      this.worldManager.setGlobal(key, value);
      worldStateUpdates.push({
        key,
        previousValue,
        value,
        reason: clampOptionalText(update.reason, 160),
      });
    }

    if (objectUpdates.length === 0 && worldStateUpdates.length === 0) {
      return null;
    }

    const location = getEventLocation(objectUpdates);
    return {
      id: generateId(),
      gameDay: gameTime.day,
      gameTick: gameTime.tick,
      type: "world_state_change",
      location,
      data: {
        objectUpdates,
        worldStateUpdates,
        description: describeAppliedUpdates(objectUpdates, worldStateUpdates),
      },
      tags: ["world_state_update"],
    };
  }

  private getRuntimeObjects(): RuntimeObjectInfo[] {
    return this.worldManager.getAllLocations().flatMap((location) =>
      this.worldManager.getLocationObjects(location.id).map((object) => ({
        id: object.id,
        name: object.name,
        locationId: location.id,
        locationName: location.name,
        state: object.state,
        stateDescription: object.stateDescription,
        knownStates: getKnownObjectStates(object),
      })),
    );
  }

  private formatEventSummary(events: SimulationEvent[]): string {
    return events
      .map((event, index) => `${index + 1}. ${this.formatEvent(event)}`)
      .join("\n");
  }

  private formatEvent(event: SimulationEvent): string {
    const actor = event.actorId ? this.getCharacterName(event.actorId) : "环境";
    const target = event.targetId ? this.getCharacterName(event.targetId) : "";
    const locationName =
      this.worldManager.getLocation(event.location)?.name ?? event.location;
    const data = event.data ?? {};

    if (event.type === "dialogue") {
      const turns = Array.isArray(data.turns)
        ? data.turns
            .map((turn: { speaker?: string; content?: string }) => {
              const speaker = turn.speaker ? this.getCharacterName(turn.speaker) : "某人";
              return `${speaker}：“${String(turn.content ?? "").trim()}”`;
            })
            .filter(Boolean)
            .join(" ")
        : JSON.stringify(data);
      return `[对话][${locationName}] ${turns}`;
    }

    if (event.type === "movement") {
      return `[移动][${locationName}] ${actor} 从 ${data.from ?? "原处"} 到 ${data.to ?? event.location}。原因：${data.reason ?? "未说明"}`;
    }

    if (event.type === "action_start" || event.type === "action_end") {
      const actionName = data.interactionName ?? data.actionName ?? data.action ?? data.interactionId ?? "行动";
      const objectName = data.objectName ? `，对象：${data.objectName}` : "";
      const reason = data.reason ? ` 原因：${data.reason}` : "";
      return `[${event.type === "action_start" ? "行动开始" : "行动结束"}][${locationName}] ${actor} ${actionName}${objectName}.${reason}`;
    }

    if (target) {
      return `[${event.type}][${locationName}] ${actor} -> ${target}: ${JSON.stringify(data)}`;
    }

    return `[${event.type}][${locationName}] ${actor}: ${JSON.stringify(data)}`;
  }

  private getCharacterName(charId: string): string {
    try {
      return this.characterManager.getProfile(charId).name;
    } catch {
      return charId;
    }
  }
}

function getKnownObjectStates(object: {
  defaultState: string;
  interactions: Array<{ availableWhenState: string[] }>;
}): string[] {
  return [
    object.defaultState,
    ...object.interactions.flatMap((interaction) => interaction.availableWhenState ?? []),
  ]
    .map((state) => state.trim())
    .filter(Boolean)
    .filter((state, index, all) => all.indexOf(state) === index);
}

function formatObjectStateBlock(objects: RuntimeObjectInfo[]): string {
  return objects
    .map((object) => {
      const knownStates =
        object.knownStates.length > 0 ? object.knownStates.join(", ") : "无";
      const description = object.stateDescription
        ? `；描述：${object.stateDescription}`
        : "";
      return `- ${object.name} (${object.id}) @ ${object.locationName}: state=${object.state}${description}；已知状态键：${knownStates}`;
    })
    .join("\n");
}

function formatWorldStateBlock(states: { key: string; value: string }[]): string {
  const visibleStates = states
    .filter((state) => !state.key.startsWith("dialogue_session:"))
    .slice(0, 30);
  if (visibleStates.length === 0) return "（无全局状态）";
  return visibleStates.map((state) => `- ${state.key}=${state.value}`).join("\n");
}

function normalizeStateKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase().replace(/[^a-z0-9_:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

function clampOptionalText(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = clampText(value, maxLength);
  return text || undefined;
}

function clampText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function isAllowedGlobalKey(key: string): boolean {
  if (RESERVED_GLOBAL_KEYS.has(key)) return false;
  return !RESERVED_GLOBAL_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function getEventLocation(objectUpdates: AppliedObjectUpdate[]): string {
  const locationIds = [...new Set(objectUpdates.map((update) => update.locationId))];
  return locationIds.length === 1 ? locationIds[0] : "global";
}

function describeAppliedUpdates(
  objectUpdates: AppliedObjectUpdate[],
  worldStateUpdates: AppliedWorldStateUpdate[],
): string {
  const parts: string[] = [];
  for (const update of objectUpdates) {
    const description = update.stateDescription ? `：${update.stateDescription}` : "";
    parts.push(`${update.objectName}变为${update.state}${description}`);
  }
  for (const update of worldStateUpdates) {
    parts.push(`${update.key}=${update.value}`);
  }
  return parts.join("；");
}

function cloneSimulationEvent(event: SimulationEvent): SimulationEvent {
  return {
    ...event,
    data: cloneJSONRecord(event.data),
    tags: [...(event.tags ?? [])],
  };
}

function cloneJSONRecord(value: Record<string, any>): Record<string, any> {
  return JSON.parse(JSON.stringify(value ?? {})) as Record<string, any>;
}

function isWorldStateUpdaterEnabled(): boolean {
  const value = process.env.WORLD_STATE_UPDATES_ENABLED;
  return value !== "0" && value !== "false";
}

function getPositiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
