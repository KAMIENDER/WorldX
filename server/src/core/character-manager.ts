import type {
  BodyCondition,
  CharacterProfile,
  CharacterState,
  GameTime,
  LifeStage,
  SimulationEvent,
  DiaryEntry,
} from "../types/index.js";
import type { WorldManager } from "./world-manager.js";
import { loadCharacterProfiles } from "../utils/config-loader.js";
import { generateId } from "../utils/id-generator.js";
import * as charStateStore from "../store/character-state-store.js";
import { MemoryManager } from "./memory-manager.js";
import { decayNeeds } from "./needs-manager.js";
import { decayEmotion } from "./emotion-manager.js";
import { getDb } from "../store/db.js";
import * as memoryStore from "../store/memory-store.js";

export class CharacterManager {
  memoryManager: MemoryManager;

  private profiles: Map<string, CharacterProfile> = new Map();

  constructor(private worldManager: WorldManager) {
    this.memoryManager = new MemoryManager();
  }

  initialize(): void {
    const profiles = loadCharacterProfiles();

    for (const p of profiles) {
      this.profiles.set(p.id, p);
    }

    const occupiedPointIds = new Set<string>();
    const spawnSeedSalt = `init:${Date.now().toString(36)}`;
    for (const profile of profiles) {
      const state = buildInitialCharacterState(
        profile,
        this.worldManager,
        occupiedPointIds,
        spawnSeedSalt,
      );
      if (state.mainAreaPointId) {
        occupiedPointIds.add(state.mainAreaPointId);
      }
      charStateStore.initCharacterState(state);

      for (const initMem of profile.initialMemories) {
        if (
          memoryStore.hasMemory(
            profile.id,
            initMem.type,
            initMem.content,
            1,
            0,
          )
        ) {
          continue;
        }

        this.memoryManager.addMemory({
          characterId: profile.id,
          type: initMem.type,
          content: initMem.content,
          gameTime: { day: 1, tick: 0 },
          importance: initMem.importance,
          emotionalValence: initMem.emotionalValence,
          emotionalIntensity: initMem.emotionalIntensity,
          relatedCharacters: initMem.relatedCharacters,
          relatedLocation: initMem.relatedLocation,
          relatedObjects: initMem.relatedObjects,
          tags: initMem.tags,
        });
      }

      if (profile.backstory) {
        const backstoryMemContent = profile.backstory;
        if (
          !memoryStore.hasMemory(profile.id, "experience", backstoryMemContent, 1, 0)
        ) {
          this.memoryManager.addMemory({
            characterId: profile.id,
            type: "experience",
            content: backstoryMemContent,
            gameTime: { day: 1, tick: 0 },
            importance: 8,
            emotionalValence: 0,
            emotionalIntensity: 3,
            relatedCharacters: [],
            relatedLocation: profile.startPosition,
            relatedObjects: [],
            tags: ["backstory"],
          });
        }
      }
    }

  }

  getProfile(charId: string): CharacterProfile {
    const p = this.profiles.get(charId);
    if (!p) throw new Error(`Profile not found: ${charId}`);
    return p;
  }

  getAllProfiles(): CharacterProfile[] {
    return Array.from(this.profiles.values());
  }

  getAliveProfiles(): CharacterProfile[] {
    return this.getAllProfiles().filter((profile) => this.isAlive(profile.id));
  }

  isAlive(charId: string): boolean {
    try {
      return this.getState(charId).isAlive;
    } catch {
      return false;
    }
  }

  /** Editable subset of CharacterProfile fields. */
  static readonly EDITABLE_FIELDS = [
    "coreMotivation", "coreValues", "speakingStyle",
    "fears", "backstory", "socialStyle", "tags",
  ] as const;

  patchProfile(
    charId: string,
    patch: Partial<Pick<CharacterProfile, (typeof CharacterManager.EDITABLE_FIELDS)[number]>>,
  ): CharacterProfile {
    const existing = this.profiles.get(charId);
    if (!existing) throw new Error(`Profile not found: ${charId}`);
    const cleaned: Record<string, unknown> = {};
    for (const key of CharacterManager.EDITABLE_FIELDS) {
      if (key in patch) cleaned[key] = (patch as Record<string, unknown>)[key];
    }
    const updated = { ...existing, ...cleaned };
    this.profiles.set(charId, updated);
    return updated;
  }

  getState(charId: string): CharacterState {
    return charStateStore.getCharacterState(charId);
  }

  getAllStates(): CharacterState[] {
    return charStateStore.getAllCharacterStates();
  }

  resetStatesForNewScene(): void {
    const occupiedPointIds = new Set<string>();
    const currentTime = this.worldManager.getCurrentTime();
    const spawnSeedSalt = `scene:${currentTime.day}:${Date.now().toString(36)}`;

    for (const profile of this.getAliveProfiles()) {
      const initialState = buildInitialCharacterState(
        profile,
        this.worldManager,
        occupiedPointIds,
        spawnSeedSalt,
      );
      if (initialState.mainAreaPointId) {
        occupiedPointIds.add(initialState.mainAreaPointId);
      }

      charStateStore.updateCharacterState(profile.id, {
        location: initialState.location,
        mainAreaPointId: initialState.mainAreaPointId,
        currentAction: initialState.currentAction,
        currentActionTarget: initialState.currentActionTarget,
        actionStartTick: initialState.actionStartTick,
        actionEndTick: initialState.actionEndTick,
        emotionValence: initialState.emotionValence,
        emotionArousal: initialState.emotionArousal,
        curiosity: initialState.curiosity,
        dailyPlan: initialState.dailyPlan,
      });
    }
  }

  updateState(charId: string, patch: Partial<CharacterState>): void {
    charStateStore.updateCharacterState(charId, patch);
  }

  tickPassiveUpdate(charId: string, currentTime: GameTime): SimulationEvent[] {
    const state = this.getState(charId);
    if (!state.isAlive) return [];

    const profile = this.getProfile(charId);

    const needsPatch = decayNeeds(state, profile, currentTime.tick);
    const emotionResult = decayEmotion({
      valence: state.emotionValence,
      arousal: state.emotionArousal,
    });

    const fullPatch: Partial<CharacterState> = {
      ...needsPatch,
      emotionValence: emotionResult.valence,
      emotionArousal: emotionResult.arousal,
    };

    charStateStore.updateCharacterState(charId, fullPatch);
    return [];
  }

  advanceLifeAtEndOfDay(gameTime: GameTime): SimulationEvent[] {
    const events: SimulationEvent[] = [];

    for (const profile of this.getAliveProfiles()) {
      const state = this.getState(profile.id);
      const next = computeDailyLifeUpdate(profile, state, gameTime);
      charStateStore.updateCharacterState(profile.id, next.patch);
      if (next.deathCause) {
        events.push(this.markDead(profile.id, gameTime, next.deathCause));
      }
    }

    return events;
  }

  markDead(charId: string, gameTime: GameTime, cause: string): SimulationEvent {
    const state = this.getState(charId);
    charStateStore.updateCharacterState(charId, {
      health: 0,
      bodyCondition: "dead",
      isAlive: false,
      deathDay: gameTime.day,
      deathTick: gameTime.tick,
      deathCause: cause,
      currentAction: null,
      currentActionTarget: null,
      actionStartTick: 0,
      actionEndTick: 0,
    });

    return {
      id: generateId(),
      gameDay: gameTime.day,
      gameTick: gameTime.tick,
      type: "life_status",
      actorId: charId,
      location: state.location,
      data: {
        status: "dead",
        cause,
        health: 0,
        bodyCondition: "dead",
      },
      tags: ["life", "death"],
    };
  }

  getCharactersAtLocation(
    locationId: string,
  ): { profile: CharacterProfile; state: CharacterState }[] {
    const states = charStateStore.getCharactersByLocation(locationId);
    return states
      .filter((s) => s.isAlive)
      .map((s) => ({
        profile: this.getProfile(s.characterId),
        state: s,
      }));
  }

  addDiaryEntry(charId: string, gameDay: number, content: string): DiaryEntry {
    const entry: DiaryEntry = {
      id: generateId(),
      characterId: charId,
      gameDay,
      content,
    };

    getDb()
      .prepare(
        `INSERT INTO diary_entries (id, character_id, game_day, content) VALUES (?, ?, ?, ?)`,
      )
      .run(entry.id, entry.characterId, entry.gameDay, entry.content);

    return entry;
  }

  getDiaryEntries(charId: string, gameDay?: number): DiaryEntry[] {
    if (gameDay !== undefined) {
      return (
        getDb()
          .prepare(
            "SELECT * FROM diary_entries WHERE character_id = ? AND game_day = ? ORDER BY rowid",
          )
          .all(charId, gameDay) as any[]
      ).map(rowToDiary);
    }

    return (
      getDb()
        .prepare(
          "SELECT * FROM diary_entries WHERE character_id = ? ORDER BY game_day, rowid",
        )
        .all(charId) as any[]
    ).map(rowToDiary);
  }
}

function rowToDiary(row: any): DiaryEntry {
  return {
    id: row.id,
    characterId: row.character_id,
    gameDay: row.game_day,
    content: row.content,
  };
}

function buildInitialCharacterState(
  profile: CharacterProfile,
  worldManager: WorldManager,
  occupiedPointIds: Set<string>,
  spawnSeedSalt: string,
): CharacterState {
  const spawnSeed = `${profile.id}:${spawnSeedSalt}`;
  let mainAreaPointId: string | null = null;
  if (profile.startPosition === "main_area") {
    if (profile.anchor?.type === "element") {
      const elementPointId = `element_${profile.anchor.targetId}`;
      const point = worldManager.getMainAreaPoint(elementPointId);
      // Anchored characters always spawn at their anchor point, even if it's
      // in a small disconnected component of the point graph.
      mainAreaPointId = point
        ? elementPointId
        : worldManager.getSpreadMainAreaPointId(spawnSeed, occupiedPointIds);
    } else {
      mainAreaPointId = worldManager.getSpreadMainAreaPointId(spawnSeed, occupiedPointIds);
    }
  }

  return {
    characterId: profile.id,
    location: profile.startPosition,
    mainAreaPointId,
    currentAction: null,
    currentActionTarget: null,
    actionStartTick: 0,
    actionEndTick: 0,
    emotionValence: 1,
    emotionArousal: clampStat(3 + profile.extraversionLevel * 2),
    curiosity: clampStat(64 + profile.intuitionLevel * 20),
    ...buildInitialLifeState(profile),
    dailyPlan: null,
  };
}

function clampStat(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function buildInitialLifeState(profile: CharacterProfile): Pick<
  CharacterState,
  | "ageYears"
  | "ageDays"
  | "lifeStage"
  | "health"
  | "bodyCondition"
  | "isAlive"
  | "deathDay"
  | "deathTick"
  | "deathCause"
> {
  const ageYears = inferInitialAge(profile);
  const health = inferInitialHealth(profile, ageYears);
  return {
    ageYears,
    ageDays: hashInt(`${profile.id}:age-days`, 365),
    lifeStage: getLifeStage(ageYears),
    health,
    bodyCondition: getBodyCondition(health),
    isAlive: true,
    deathDay: null,
    deathTick: null,
    deathCause: null,
  };
}

function inferInitialAge(profile: CharacterProfile): number {
  if (typeof profile.ageYears === "number" && Number.isFinite(profile.ageYears)) {
    return Math.max(0, Math.min(120, Math.round(profile.ageYears)));
  }

  const text = `${profile.name} ${profile.role} ${profile.backstory ?? ""} ${profile.tags.join(" ")}`;
  if (/儿童|孩子|小孩|孩童|少年|child|kid/i.test(text)) return 10 + hashInt(profile.id, 5);
  if (/少女|少男|学生|teen/i.test(text)) return 15 + hashInt(profile.id, 5);
  if (/老人|老者|老翁|老妪|老醉|elder|old/i.test(text)) return 60 + hashInt(profile.id, 18);
  if (/网红|游客|学徒|apprentice/i.test(text)) return 20 + hashInt(profile.id, 10);
  if (/掌柜|老板|捕头|guard|chief|blacksmith|healer/i.test(text)) return 32 + hashInt(profile.id, 18);
  return 24 + hashInt(profile.id, 32);
}

function inferInitialHealth(profile: CharacterProfile, ageYears: number): number {
  const text = `${profile.name} ${profile.role} ${profile.backstory ?? ""} ${profile.tags.join(" ")}`;
  const agePenalty = ageYears >= 75 ? 12 : ageYears >= 60 ? 6 : 0;
  const conditionPenalty = /病|伤|醉|sick|injured|drunk/i.test(text) ? 12 : 0;
  return clampStat(96 - agePenalty - conditionPenalty);
}

function computeDailyLifeUpdate(
  profile: CharacterProfile,
  state: CharacterState,
  gameTime: GameTime,
): { patch: Partial<CharacterState>; deathCause?: string } {
  let ageYears = state.ageYears;
  let ageDays = state.ageDays + 1;
  if (ageDays >= 365) {
    ageYears += 1;
    ageDays = 0;
  }

  let healthDelta = 1;
  if (state.bodyCondition === "sick") healthDelta -= 4;
  if (state.bodyCondition === "injured") healthDelta -= 5;
  if (state.bodyCondition === "critical") healthDelta -= 8;
  if (ageYears >= 90) healthDelta -= 2;
  else if (ageYears >= 75) healthDelta -= 1;

  let bodyCondition = state.bodyCondition;
  const illnessRisk = ageYears >= 85 ? 0.06 : ageYears >= 65 ? 0.025 : 0.006;
  const roll = hashUnit(`${profile.id}:illness:${gameTime.day}`);
  if ((bodyCondition === "healthy" || bodyCondition === "tired") && roll < illnessRisk) {
    bodyCondition = "sick";
    healthDelta -= 8;
  }

  const health = clampStat(state.health + healthDelta);
  if (health <= 0 || ageYears >= 120) {
    return {
      patch: {
        ageYears,
        ageDays,
        lifeStage: getLifeStage(ageYears),
        health: 0,
        bodyCondition: "dead",
        isAlive: false,
        deathDay: gameTime.day,
        deathTick: gameTime.tick,
        deathCause: ageYears >= 120 ? "寿终" : "身体状况恶化",
      },
      deathCause: ageYears >= 120 ? "寿终" : "身体状况恶化",
    };
  }

  bodyCondition = getBodyCondition(health, bodyCondition);
  return {
    patch: {
      ageYears,
      ageDays,
      lifeStage: getLifeStage(ageYears),
      health,
      bodyCondition,
    },
  };
}

function getLifeStage(ageYears: number): LifeStage {
  if (ageYears < 13) return "child";
  if (ageYears < 20) return "teen";
  if (ageYears >= 65) return "elder";
  return "adult";
}

function getBodyCondition(health: number, current: BodyCondition = "healthy"): BodyCondition {
  if (health <= 0) return "dead";
  if (health <= 20) return "critical";
  if (current === "injured" && health <= 70) return "injured";
  if (current === "sick" && health <= 70) return "sick";
  if (health <= 45) return "sick";
  if (health <= 75) return "tired";
  return "healthy";
}

function hashInt(input: string, modulo: number): number {
  if (modulo <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash % modulo;
}

function hashUnit(input: string): number {
  return hashInt(input, 1_000_000) / 1_000_000;
}
