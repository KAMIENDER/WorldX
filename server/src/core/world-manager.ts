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
const MIN_PREFERRED_MAIN_AREA_COMPONENT_SIZE = 6;
const MIN_PREFERRED_MAIN_AREA_COMPONENT_RATIO = 0.5;
const MAIN_AREA_SPAWN_EDGE_PADDING_TILE_MULTIPLIER = 3;
const MAIN_AREA_SPAWN_EDGE_PADDING_RATIO = 0.03;
const MAIN_AREA_SPAWN_INTERIOR_POOL_RATIO = 0.5;

export interface TickAdvanceResult {
  previousTime: GameTime;
  currentTime: GameTime;
  didAdvanceDay: boolean;
  cycleTicks: number;
}

export type MainAreaZone = "东" | "南" | "西" | "北" | "中";

export class WorldManager {
  private locationConfigs: LocationConfig[] = [];
  private mainAreaPoints: MainAreaPointConfig[] = [];
  private preferredMainAreaPointIds: Set<string> | null = null;
  private mainAreaZoneMap: Map<string, MainAreaZone> = new Map();
  private worldActions: WorldActionConfig[] = [];
  private worldSize: WorldSizeConfig | null = null;
  private sceneConfig!: SceneConfig;
  private worldName = "unknown";
  private worldDescription = "";
  private worldSocialContext = "";
  private contentLanguage: "zh" | "en" = "zh";
  private originalPrompt = "";

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
    this.preferredMainAreaPointIds = getLargestMainAreaPointComponent(this.mainAreaPoints);
    this.mainAreaZoneMap = computeMainAreaZones(this.mainAreaPoints);
    this.worldSize = normalizeWorldSize(config.worldSize) ?? inferWorldSizeFromWorldDir();
    this.worldActions = config.worldActions ?? [];
    this.worldName = config.worldName ?? "unknown";
    this.worldDescription = config.worldDescription ?? "";
    this.worldSocialContext = buildWorldSocialContext(
      config.worldSocialContext,
      this.worldDescription,
    );
    this.contentLanguage = config.contentLanguage ?? "zh";
    this.originalPrompt = config.originalPrompt ?? "";
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

  getOriginalPrompt(): string {
    return this.originalPrompt;
  }

  getWorldSocialContext(): string {
    return this.worldSocialContext;
  }

  getContentLanguage(): "zh" | "en" {
    return this.contentLanguage;
  }

  getSceneConfig(): SceneConfig {
    return this.sceneConfig;
  }

  applySceneConfigOverride(override: Partial<SceneConfig>): void {
    this.sceneConfig = mergeSceneConfigOverride(this.sceneConfig, override);
    const restoredTime = this.restorePersistedTime();
    this.syncSceneClock(restoredTime.day);
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

  getMainAreaPointZone(pointId: string | null | undefined): MainAreaZone {
    if (!pointId) return "中";
    return this.mainAreaZoneMap.get(pointId) ?? "中";
  }

  getAvailableMainAreaZones(): MainAreaZone[] {
    if (this.mainAreaZoneMap.size === 0) return [];
    return [...new Set(this.mainAreaZoneMap.values())];
  }

  pickPointInZone(zone: MainAreaZone, seed: string, excludePointId?: string | null): string | null {
    const preferred = this.getPreferredSpawnMainAreaPoints();
    const candidates = preferred.filter(
      (p) => this.mainAreaZoneMap.get(p.id) === zone && p.id !== excludePointId,
    );
    if (candidates.length === 0) return null;
    const index = Math.abs(hashString(seed)) % candidates.length;
    return candidates[index].id;
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
    const points = this.getSpawnCandidateMainAreaPoints(this.getPreferredSpawnMainAreaPoints());
    const index = Math.abs(hashString(seed)) % points.length;
    return points[index]?.id ?? null;
  }

  /**
   * Pick a spawn point that avoids already-occupied points when possible.
   * Falls back to the hash-based default if every point is taken.
   */
  getSpreadMainAreaPointId(seed: string, occupied: Set<string>): string | null {
    if (!this.hasMainAreaPointGraph()) return null;
    const points = this.getPreferredSpawnMainAreaPoints();
    if (points.length === 0) return null;

    const edgeSafePoints = this.getSpawnCandidateMainAreaPoints(points);
    const free = points.filter((p) => !occupied.has(p.id));
    const edgeSafeFree = edgeSafePoints.filter((p) => !occupied.has(p.id));
    if (free.length === 0) {
      const fallbackPool = edgeSafePoints.length > 0 ? edgeSafePoints : points;
      const index = Math.abs(hashString(seed)) % fallbackPool.length;
      return fallbackPool[index]?.id ?? null;
    }

    const preferredPool = edgeSafeFree.length > 0 ? edgeSafeFree : free;
    const index = Math.abs(hashString(seed)) % preferredPool.length;
    return preferredPool[index]?.id ?? null;
  }

  pickDistantMainAreaPointId(currentPointId: string | null | undefined, seed: string): string | null {
    if (!this.hasMainAreaPointGraph()) return null;
    const points = this.getPreferredSpawnMainAreaPoints();
    const current = this.getMainAreaPoint(currentPointId);
    if (!current || !points.some((point) => point.id === current.id)) {
      return this.getInitialMainAreaPointId(seed);
    }

    const farCandidates = points.filter(
      (point) => point.id !== current.id && !current.adjacentPointIds.includes(point.id),
    );
    const candidatePool = farCandidates.length > 0
      ? farCandidates
      : points.filter((point) => point.id !== current.id);
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

  isPreferredSpawnMainAreaPoint(pointId: string | null | undefined): boolean {
    if (!pointId) return false;
    if (!this.preferredMainAreaPointIds || this.preferredMainAreaPointIds.size === 0) {
      return this.mainAreaPoints.some((point) => point.id === pointId);
    }
    return this.preferredMainAreaPointIds.has(pointId);
  }

  getWorldActions(): WorldActionConfig[] {
    return this.worldActions;
  }

  resetTransientStateForNewScene(): void {
    for (const objectState of worldState.getAllObjectStates()) {
      if (objectState.currentUsers.length === 0) continue;
      worldState.updateObjectState(objectState.objectId, {
        currentUsers: [],
      });
    }
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

  private getPreferredSpawnMainAreaPoints(): MainAreaPointConfig[] {
    if (!this.preferredMainAreaPointIds || this.preferredMainAreaPointIds.size === 0) {
      return this.mainAreaPoints;
    }
    const filtered = this.mainAreaPoints.filter((point) => this.preferredMainAreaPointIds?.has(point.id));
    return filtered.length > 0 ? filtered : this.mainAreaPoints;
  }

  private getSpawnCandidateMainAreaPoints(points: MainAreaPointConfig[]): MainAreaPointConfig[] {
    if (points.length <= 1) return points;
    if (!this.worldSize) return points;

    const edgePadding = this.getMainAreaSpawnEdgePaddingPx();
    const edgeSafe = edgePadding > 0
      ? points.filter(
          (point) =>
            point.x >= edgePadding &&
            point.x <= this.worldSize!.width - edgePadding &&
            point.y >= edgePadding &&
            point.y <= this.worldSize!.height - edgePadding,
        )
      : points;
    const candidatePool = edgeSafe.length > 0 ? edgeSafe : points;
    if (candidatePool.length <= 2) return candidatePool;

    const ranked = [...candidatePool].sort(
      (a, b) => this.getMainAreaPointInteriorScore(b) - this.getMainAreaPointInteriorScore(a),
    );
    const preferredCount = Math.max(
      1,
      Math.ceil(ranked.length * MAIN_AREA_SPAWN_INTERIOR_POOL_RATIO),
    );
    return ranked.slice(0, preferredCount);
  }

  private getMainAreaSpawnEdgePaddingPx(): number {
    if (!this.worldSize) return 0;
    const tileSize = this.worldSize.tileSize && Number.isFinite(this.worldSize.tileSize)
      ? this.worldSize.tileSize
      : 32;
    const proportionalPadding =
      Math.min(this.worldSize.width, this.worldSize.height) * MAIN_AREA_SPAWN_EDGE_PADDING_RATIO;
    return Math.max(tileSize * MAIN_AREA_SPAWN_EDGE_PADDING_TILE_MULTIPLIER, proportionalPadding);
  }

  private getMainAreaPointInteriorScore(point: MainAreaPointConfig): number {
    if (!this.worldSize) return 0;
    return Math.min(
      point.x,
      this.worldSize.width - point.x,
      point.y,
      this.worldSize.height - point.y,
    );
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

  getAllGlobalState(): { key: string; value: string }[] {
    return worldState.getAllGlobalState();
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

function mergeSceneConfigOverride(base: SceneConfig, override: Partial<SceneConfig>): SceneConfig {
  const nextTickDuration =
    typeof override.tickDurationMinutes === "number" && Number.isFinite(override.tickDurationMinutes)
      ? Math.max(1, Math.floor(override.tickDurationMinutes))
      : base.tickDurationMinutes;
  let nextMaxTicks = override.maxTicks ?? base.maxTicks;

  if (
    override.tickDurationMinutes !== undefined &&
    override.maxTicks === undefined &&
    base.sceneType === "open" &&
    base.maxTicks != null
  ) {
    const cycleMinutes = Math.max(1, base.maxTicks) * base.tickDurationMinutes;
    nextMaxTicks = Math.max(1, Math.round(cycleMinutes / nextTickDuration));
  }

  return {
    ...base,
    ...override,
    tickDurationMinutes: nextTickDuration,
    maxTicks: nextMaxTicks,
    multiDay: {
      ...base.multiDay,
      ...override.multiDay,
    },
  };
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

function getLargestMainAreaPointComponent(points: MainAreaPointConfig[]): Set<string> | null {
  if (points.length === 0) return null;

  const pointMap = new Map(points.map((point) => [point.id, point]));
  const reverseAdjacency = new Map<string, string[]>();
  for (const point of points) {
    for (const neighborId of point.adjacentPointIds || []) {
      if (!pointMap.has(neighborId)) continue;
      const reverse = reverseAdjacency.get(neighborId) ?? [];
      reverse.push(point.id);
      reverseAdjacency.set(neighborId, reverse);
    }
  }

  const visited = new Set<string>();
  let largest: Set<string> | null = null;

  for (const point of points) {
    if (visited.has(point.id)) continue;

    const component = new Set<string>();
    const queue = [point.id];
    visited.add(point.id);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      component.add(currentId);
      const current = pointMap.get(currentId);
      if (!current) continue;

      const neighbors = [
        ...(current.adjacentPointIds || []).filter((neighborId) => pointMap.has(neighborId)),
        ...(reverseAdjacency.get(currentId) || []),
      ];
      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        queue.push(neighborId);
      }
    }

    if (!largest || component.size > largest.size) {
      largest = component;
    }
  }

  if (!largest) return null;

  const componentRatio = largest.size / points.length;
  if (
    largest.size < MIN_PREFERRED_MAIN_AREA_COMPONENT_SIZE ||
    componentRatio < MIN_PREFERRED_MAIN_AREA_COMPONENT_RATIO
  ) {
    return null;
  }

  return largest;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.2;
  return Math.max(0.02, Math.min(0.5, value));
}

function buildWorldSocialContext(
  socialContext?: string,
  worldDescription?: string,
): string {
  const trimmedContext = typeof socialContext === "string" ? socialContext.trim() : "";
  if (trimmedContext) return trimmedContext;
  const trimmedDescription = typeof worldDescription === "string" ? worldDescription.trim() : "";
  if (trimmedDescription) return trimmedDescription;
  return "这是一个有自身日常秩序的小世界。让背景只作为处事底色，别机械复述设定。";
}

const MIN_POINTS_FOR_ZONES = 5;

function computeMainAreaZones(points: MainAreaPointConfig[]): Map<string, MainAreaZone> {
  const zoneMap = new Map<string, MainAreaZone>();
  if (points.length === 0) return zoneMap;
  if (points.length < MIN_POINTS_FOR_ZONES) {
    for (const p of points) zoneMap.set(p.id, "中");
    return zoneMap;
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;
  if (rangeX < 1 && rangeY < 1) {
    for (const p of points) zoneMap.set(p.id, "中");
    return zoneMap;
  }

  for (const p of points) {
    const nx = rangeX > 0 ? (p.x - minX) / rangeX : 0.5;
    const ny = rangeY > 0 ? (p.y - minY) / rangeY : 0.5;
    const inCenterX = nx >= 0.3 && nx <= 0.7;
    const inCenterY = ny >= 0.3 && ny <= 0.7;
    if (inCenterX && inCenterY) {
      zoneMap.set(p.id, "中");
    } else {
      const devX = Math.abs(nx - 0.5);
      const devY = Math.abs(ny - 0.5);
      if (devX >= devY) {
        zoneMap.set(p.id, nx < 0.5 ? "西" : "东");
      } else {
        zoneMap.set(p.id, ny < 0.5 ? "北" : "南");
      }
    }
  }
  return zoneMap;
}
