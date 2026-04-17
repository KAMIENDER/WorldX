import fs from "node:fs";
import path from "node:path";
import type {
  LocationConfig,
  MainAreaPointConfig,
  ObjectConfig,
  ObjectRuntimeState,
  InteractionConfig,
  WorldActionConfig,
  WorldSizeConfig,
  GameTime,
  DialogueSession,
  SceneConfig,
} from "../types/index.js";
import { loadWorldConfig, loadSceneConfig, setWorldDir, getWorldDir } from "../utils/config-loader.js";
import { setSceneConfig, isSceneComplete, getTicksPerScene } from "../utils/time-helpers.js";
import * as worldState from "../store/world-state-store.js";
import * as snapshotStore from "../store/snapshot-store.js";
import type { SnapshotMeta } from "../store/snapshot-store.js";

const DIALOGUE_SESSION_PREFIX = "dialogue_session:";
const MAIN_AREA_DIALOGUE_DISTANCE_RATIO = clampRatio(
  parseFloat(process.env.MAIN_AREA_DIALOGUE_DISTANCE_RATIO || "0.4"),
);

export interface TickAdvanceResult {
  previousTime: GameTime;
  currentTime: GameTime;
  didAdvanceDay: boolean;
  cycleTicks: number;
}

export class WorldManager {
  private locationConfigs: LocationConfig[] = [];
  private mainAreaPoints: MainAreaPointConfig[] = [];
  private worldActions: WorldActionConfig[] = [];
  private worldSize: WorldSizeConfig | null = null;
  private sceneConfig!: SceneConfig;
  private worldName = "unknown";
  private worldDescription = "";

  constructor() {}

  initialize(worldDirPath?: string): void {
    if (worldDirPath) {
      setWorldDir(worldDirPath);
    }
    const config = loadWorldConfig();
    this.locationConfigs = normalizeLocations(
      config.locations,
      config.worldName ?? "main_area",
      config.worldDescription ?? "",
    );
    this.mainAreaPoints = normalizeMainAreaPoints(config.mainAreaPoints);
    this.worldSize = normalizeWorldSize(config.worldSize) ?? inferWorldSizeFromWorldDir();
    this.worldActions = config.worldActions ?? [];
    this.worldName = config.worldName ?? "unknown";
    this.worldDescription = config.worldDescription ?? "";
    this.sceneConfig = loadSceneConfig();

    worldState.initWorldState(this.locationConfigs);
    const restoredTime = this.restorePersistedTime();
    this.syncSceneClock(restoredTime.day);
  }

  getWorldName(): string {
    return this.worldName;
  }

  getWorldDescription(): string {
    return this.worldDescription;
  }

  getSceneConfig(): SceneConfig {
    return this.sceneConfig;
  }

  getCurrentTime(): GameTime {
    const day = parseInt(worldState.getGlobalState("current_day") ?? "1", 10);
    const tick = parseInt(worldState.getGlobalState("current_tick") ?? "0", 10);
    return { day, tick };
  }

  advanceTick(): TickAdvanceResult {
    const previousTime = this.getCurrentTime();
    const { day, tick } = previousTime;
    const cycleTicks = getTicksPerScene({
      sceneType: this.sceneConfig.sceneType,
      startTime: this.sceneConfig.startTime,
      tickDurationMinutes: this.sceneConfig.tickDurationMinutes,
      maxTicks: this.sceneConfig.maxTicks,
      sceneDay: day,
      displayFormat: this.sceneConfig.displayFormat,
      multiDay: this.sceneConfig.multiDay,
    });

    let newTick: number;
    let newDay: number;

    if (tick >= cycleTicks - 1) {
      newTick = 0;
      newDay = day + 1;
    } else {
      newTick = tick + 1;
      newDay = day;
    }

    worldState.setGlobalState("current_tick", String(newTick));
    worldState.setGlobalState("current_day", String(newDay));
    this.syncSceneClock(newDay);

    return {
      previousTime,
      currentTime: { day: newDay, tick: newTick },
      didAdvanceDay: newDay !== day,
      cycleTicks,
    };
  }

  isSceneComplete(): boolean {
    const currentTime = this.getCurrentTime();
    return isSceneComplete(currentTime.tick, {
      sceneType: this.sceneConfig.sceneType,
      startTime: this.sceneConfig.startTime,
      tickDurationMinutes: this.sceneConfig.tickDurationMinutes,
      maxTicks: this.sceneConfig.maxTicks,
      sceneDay: currentTime.day,
      displayFormat: this.sceneConfig.displayFormat,
      multiDay: this.sceneConfig.multiDay,
    });
  }

  setTime(time: GameTime): void {
    worldState.setGlobalState("current_day", String(time.day));
    worldState.setGlobalState("current_tick", String(time.tick));
    this.syncSceneClock(time.day);
  }

  getLocation(locationId: string): LocationConfig | undefined {
    return this.locationConfigs.find((l) => l.id === locationId);
  }

  getAllLocations(): LocationConfig[] {
    return this.locationConfigs;
  }

  getMainAreaPoints(): MainAreaPointConfig[] {
    return this.mainAreaPoints;
  }

  getWorldSize(): WorldSizeConfig | null {
    return this.worldSize;
  }

  getMainAreaDialogueDistanceThreshold(): number | null {
    const size = this.worldSize;
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
      return null;
    }
    return ((size.width + size.height) / 2) * MAIN_AREA_DIALOGUE_DISTANCE_RATIO;
  }

  getMainAreaPoint(pointId: string | null | undefined): MainAreaPointConfig | undefined {
    if (!pointId) return undefined;
    return this.mainAreaPoints.find((point) => point.id === pointId);
  }

  hasMainAreaPointGraph(): boolean {
    return this.mainAreaPoints.length > 0;
  }

  hasMultipleMainAreaPoints(): boolean {
    return this.mainAreaPoints.length > 1;
  }

  areMainAreaPointsConversable(pointA: string | null | undefined, pointB: string | null | undefined): boolean {
    if (!this.hasMainAreaPointGraph()) return true;
    if (!pointA || !pointB) return false;
    if (pointA === pointB) return true;
    const threshold = this.getMainAreaDialogueDistanceThreshold();
    if (threshold != null) {
      const a = this.getMainAreaPoint(pointA);
      const b = this.getMainAreaPoint(pointB);
      if (!a || !b) return false;
      return distanceBetweenPoints(a, b) <= threshold;
    }
    const from = this.getMainAreaPoint(pointA);
    return !!from?.adjacentPointIds.includes(pointB);
  }

  getInitialMainAreaPointId(seed: string): string | null {
    if (!this.hasMainAreaPointGraph()) return null;
    const points = this.mainAreaPoints;
    const index = Math.abs(hashString(seed)) % points.length;
    return points[index]?.id ?? null;
  }

  pickDistantMainAreaPointId(currentPointId: string | null | undefined, seed: string): string | null {
    if (!this.hasMainAreaPointGraph()) return null;
    const current = this.getMainAreaPoint(currentPointId);
    if (!current) {
      return this.getInitialMainAreaPointId(seed);
    }

    const farCandidates = this.mainAreaPoints.filter(
      (point) => point.id !== current.id && !current.adjacentPointIds.includes(point.id),
    );
    const candidatePool = farCandidates.length > 0
      ? farCandidates
      : this.mainAreaPoints.filter((point) => point.id !== current.id);
    if (candidatePool.length === 0) return current.id;

    const ranked = [...candidatePool].sort((a, b) => {
      const distA = distanceBetweenPoints(a, current);
      const distB = distanceBetweenPoints(b, current);
      return distB - distA;
    });
    const preferredPool = ranked.slice(0, Math.max(1, Math.ceil(ranked.length * 0.6)));
    const pickIndex = Math.abs(hashString(`${seed}:${current.id}`)) % preferredPool.length;
    return preferredPool[pickIndex]?.id ?? preferredPool[0]?.id ?? null;
  }

  getWorldActions(): WorldActionConfig[] {
    return this.worldActions;
  }

  private syncSceneClock(sceneDay: number): void {
    setSceneConfig({
      sceneType: this.sceneConfig.sceneType,
      startTime: this.sceneConfig.startTime,
      tickDurationMinutes: this.sceneConfig.tickDurationMinutes,
      maxTicks: this.sceneConfig.maxTicks,
      sceneDay,
      displayFormat: this.sceneConfig.displayFormat,
      multiDay: this.sceneConfig.multiDay,
    });
  }

  private restorePersistedTime(): GameTime {
    const rawDay = Number.parseInt(worldState.getGlobalState("current_day") ?? "1", 10);
    const rawTick = Number.parseInt(worldState.getGlobalState("current_tick") ?? "0", 10);

    const day = Number.isFinite(rawDay) && rawDay > 0 ? rawDay : 1;
    let tick = Number.isFinite(rawTick) && rawTick >= 0 ? rawTick : 0;

    const cycleTicks = getTicksPerScene({
      sceneType: this.sceneConfig.sceneType,
      startTime: this.sceneConfig.startTime,
      tickDurationMinutes: this.sceneConfig.tickDurationMinutes,
      maxTicks: this.sceneConfig.maxTicks,
      sceneDay: day,
      displayFormat: this.sceneConfig.displayFormat,
      multiDay: this.sceneConfig.multiDay,
    });
    tick = Math.min(tick, Math.max(0, cycleTicks - 1));

    worldState.setGlobalState("current_day", String(day));
    worldState.setGlobalState("current_tick", String(tick));
    return { day, tick };
  }

  getWorldAction(actionId: string): WorldActionConfig | undefined {
    return this.worldActions.find((action) => action.id === actionId);
  }

  getAdjacentLocations(locationId: string): string[] {
    return this.getLocation(locationId)?.adjacentLocations ?? [];
  }

  getLocationObjects(locationId: string): (ObjectConfig & ObjectRuntimeState)[] {
    const loc = this.getLocation(locationId);
    if (!loc) return [];

    const runtimeStates = worldState.getObjectsByLocation(locationId);
    const stateMap = new Map(runtimeStates.map((s) => [s.objectId, s]));

    return loc.objects.map((obj) => {
      const runtime = stateMap.get(obj.id);
      return {
        ...obj,
        objectId: obj.id,
        locationId: obj.locationId,
        state: runtime?.state ?? obj.defaultState,
        stateDescription: runtime?.stateDescription ?? "",
        currentUsers: runtime?.currentUsers ?? [],
      };
    });
  }

  getAvailableInteractions(objectId: string): InteractionConfig[] {
    const objConfig = this.findObjectConfig(objectId);
    if (!objConfig) return [];

    const runtime = worldState.getObjectState(objectId);
    return objConfig.interactions.filter(
      (interaction) =>
        !Array.isArray(interaction.availableWhenState) ||
        interaction.availableWhenState.includes(runtime.state),
    );
  }

  updateObjectState(objectId: string, newState: string, description?: string): void {
    const patch: Partial<ObjectRuntimeState> = { state: newState };
    if (description !== undefined) patch.stateDescription = description;
    worldState.updateObjectState(objectId, patch);
  }

  characterStartUsingObject(objectId: string, characterId: string): boolean {
    const objConfig = this.findObjectConfig(objectId);
    if (!objConfig) return false;

    const runtime = worldState.getObjectState(objectId);
    if (runtime.currentUsers.length >= objConfig.capacity) return false;

    worldState.addUserToObject(objectId, characterId);
    return true;
  }

  characterStopUsingObject(objectId: string, characterId: string): void {
    worldState.removeUserFromObject(objectId, characterId);
  }

  getGlobal(key: string): string | null {
    return worldState.getGlobalState(key);
  }

  setGlobal(key: string, value: string): void {
    worldState.setGlobalState(key, value);
  }

  listDialogueSessions(): DialogueSession[] {
    return worldState
      .getAllGlobalState()
      .filter((entry) => entry.key.startsWith(DIALOGUE_SESSION_PREFIX))
      .map((entry) => this.parseDialogueSession(entry.key, entry.value))
      .filter((session): session is DialogueSession => session !== null);
  }

  getDialogueSession(sessionId: string): DialogueSession | null {
    const raw = worldState.getGlobalState(this.sessionKey(sessionId));
    if (!raw) return null;
    return this.parseDialogueSession(this.sessionKey(sessionId), raw);
  }

  saveDialogueSession(session: DialogueSession): void {
    worldState.setGlobalState(
      this.sessionKey(session.id),
      JSON.stringify(session),
    );
  }

  deleteDialogueSession(sessionId: string): void {
    worldState.deleteGlobalState(this.sessionKey(sessionId));
  }

  findDialogueSessionByParticipants(
    charA: string,
    charB: string,
  ): DialogueSession | null {
    return (
      this.listDialogueSessions().find((session) => {
        const participants = [...session.participants].sort();
        const pair = [charA, charB].sort();
        return participants[0] === pair[0] && participants[1] === pair[1];
      }) ?? null
    );
  }

  createSnapshot(description?: string): string {
    return snapshotStore.createSnapshot(this.getCurrentTime(), description);
  }

  restoreSnapshot(snapshotId: string): void {
    snapshotStore.restoreSnapshot(snapshotId);
  }

  listSnapshots(): SnapshotMeta[] {
    return snapshotStore.listSnapshots();
  }

  private findObjectConfig(objectId: string): ObjectConfig | undefined {
    for (const loc of this.locationConfigs) {
      const obj = loc.objects.find((o) => o.id === objectId);
      if (obj) return obj;
    }
    return undefined;
  }

  private sessionKey(sessionId: string): string {
    return `${DIALOGUE_SESSION_PREFIX}${sessionId}`;
  }

  private parseDialogueSession(
    key: string,
    raw: string,
  ): DialogueSession | null {
    try {
      const parsed = JSON.parse(raw) as DialogueSession;
      if (!parsed || !Array.isArray(parsed.participants)) return null;
      return parsed;
    } catch (error) {
      console.warn(`[WorldManager] Failed to parse dialogue session ${key}:`, error);
      return null;
    }
  }
}

function normalizeLocations(
  locations: LocationConfig[] | undefined,
  worldName: string,
  worldDescription: string,
): LocationConfig[] {
  const authored = (Array.isArray(locations) ? locations : []).map((location) => ({
    ...location,
    adjacentLocations: Array.isArray(location.adjacentLocations)
      ? unique(location.adjacentLocations.filter(Boolean))
      : [],
    objects: Array.isArray(location.objects) ? location.objects : [],
  }));

  const authoredIds = authored
    .map((location) => location.id)
    .filter((locationId) => locationId && locationId !== "main_area");

  const hasMainArea = authored.some((location) => location.id === "main_area");
  const withMainArea = hasMainArea
    ? authored
    : [
        {
          id: "main_area",
          name: "主区域",
          description: worldDescription || `${worldName}中的公共活动区域`,
          adjacentLocations: [...authoredIds],
          objects: [],
        },
        ...authored,
      ];

  const allIds = new Set(withMainArea.map((location) => location.id));
  const hasAnyAuthoredAdjacency = withMainArea.some(
    (location) =>
      location.id !== "main_area" && (location.adjacentLocations?.length ?? 0) > 0,
  );

  return withMainArea.map((location) => {
    let adjacent = (location.adjacentLocations ?? []).filter(
      (adjacentId) => adjacentId !== location.id && allIds.has(adjacentId),
    );

    if (location.id === "main_area") {
      adjacent = unique([...adjacent, ...authoredIds]);
    } else if (adjacent.length === 0) {
      adjacent = hasAnyAuthoredAdjacency
        ? ["main_area"]
        : Array.from(allIds).filter((adjacentId) => adjacentId !== location.id);
    } else {
      adjacent = unique(["main_area", ...adjacent]);
    }

    return {
      ...location,
      adjacentLocations: adjacent,
    };
  });
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function normalizeMainAreaPoints(points: MainAreaPointConfig[] | undefined): MainAreaPointConfig[] {
  const normalized = (Array.isArray(points) ? points : [])
    .filter(
      (point): point is MainAreaPointConfig =>
        !!point &&
        typeof point.id === "string" &&
        typeof point.x === "number" &&
        typeof point.y === "number",
    )
    .map((point) => ({
      ...point,
      name: point.name || point.id,
      adjacentPointIds: Array.isArray(point.adjacentPointIds)
        ? unique(point.adjacentPointIds.filter((adjacentId) => adjacentId && adjacentId !== point.id))
        : [],
    }));

  const validIds = new Set(normalized.map((point) => point.id));
  return normalized.map((point) => ({
    ...point,
    adjacentPointIds: point.adjacentPointIds.filter((adjacentId) => validIds.has(adjacentId)),
  }));
}

function normalizeWorldSize(size: WorldSizeConfig | undefined): WorldSizeConfig | null {
  if (!size) return null;
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;
  return {
    width: size.width,
    height: size.height,
    tileSize: Number.isFinite(size.tileSize) ? size.tileSize : undefined,
    gridWidth: Number.isFinite(size.gridWidth) ? size.gridWidth : undefined,
    gridHeight: Number.isFinite(size.gridHeight) ? size.gridHeight : undefined,
  };
}

function inferWorldSizeFromWorldDir(): WorldSizeConfig | null {
  const worldDir = getWorldDir();
  if (!worldDir) return null;
  const tmjPath = path.join(worldDir, "map", "06-final.tmj");
  if (!fs.existsSync(tmjPath)) return null;

  try {
    const raw = fs.readFileSync(tmjPath, "utf-8");
    const tmj = JSON.parse(raw) as {
      width?: number;
      height?: number;
      tilewidth?: number;
    };
    if (
      !Number.isFinite(tmj.width) ||
      !Number.isFinite(tmj.height) ||
      !Number.isFinite(tmj.tilewidth)
    ) {
      return null;
    }
    const gridWidth = Number(tmj.width);
    const gridHeight = Number(tmj.height);
    const tileSize = Number(tmj.tilewidth);
    return {
      width: gridWidth * tileSize,
      height: gridHeight * tileSize,
      tileSize,
      gridWidth,
      gridHeight,
    };
  } catch (error) {
    console.warn("[WorldManager] Failed to infer world size from TMJ:", error);
    return null;
  }
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function distanceBetweenPoints(a: MainAreaPointConfig, b: MainAreaPointConfig): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.2;
  return Math.max(0.02, Math.min(0.5, value));
}
