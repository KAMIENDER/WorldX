import type {
  BodyCondition,
  CharacterProfile,
  CharacterRelationship,
  CharacterState,
  GameTime,
  LifeStage,
  SimulationEvent,
  DiaryEntry,
} from "../types/index.js";
import type { WorldManager } from "./world-manager.js";
import { loadCharacterProfiles } from "../utils/config-loader.js";
import { generateId } from "../utils/id-generator.js";
import { absoluteTick, tickOffsetForClockTime } from "../utils/time-helpers.js";
import * as charStateStore from "../store/character-state-store.js";
import * as relationshipStore from "../store/character-relationship-store.js";
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
      backfillNewNeedsState(profile, state);

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

    initializeRelationshipGraph(profiles);
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
    "genderLabel", "socialClass", "occupation", "homeLocation", "workLocation",
    "family", "personalityTraits", "longTermGoals",
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
    this.resetStatesForNewDay(this.worldManager.getCurrentTime().day);
  }

  resetStatesForNewDay(day: number): SimulationEvent[] {
    const events: SimulationEvent[] = [];
    const sceneConfig = this.worldManager.getSceneConfig();
    const dayStartTime: GameTime = { day, tick: 0 };
    const dayStartAbsTick = absoluteTick(dayStartTime);

    for (const profile of this.getAliveProfiles()) {
      const state = this.getState(profile.id);
      const wakeTime = state.currentAction === "sleep" ? state.sleepWakeTime : null;
      if (wakeTime) {
        const wakeTick = tickOffsetForClockTime(wakeTime, sceneConfig);
        const sleepRecovery = getSleepRecoveryPatch(state);
        if (wakeTick <= 0) {
          charStateStore.updateCharacterState(profile.id, {
            currentAction: null,
            currentActionTarget: null,
            actionStartTick: 0,
            actionEndTick: 0,
            sleepWakeTime: null,
            emotionArousal: Math.max(1, state.emotionArousal - 1),
            ...sleepRecovery,
          });
          events.push(buildWakeEvent(profile.id, state.location, wakeTime, dayStartTime));
        } else {
          charStateStore.updateCharacterState(profile.id, {
            currentAction: "sleep",
            currentActionTarget: null,
            actionStartTick: dayStartAbsTick,
            actionEndTick: dayStartAbsTick + wakeTick,
            sleepWakeTime: wakeTime,
            emotionArousal: Math.max(1, state.emotionArousal - 1),
            ...sleepRecovery,
          });
        }
        continue;
      }

      charStateStore.updateCharacterState(profile.id, {
        currentAction: null,
        currentActionTarget: null,
        actionStartTick: 0,
        actionEndTick: 0,
        sleepWakeTime: null,
      });
    }

    return events;
  }

  updateState(charId: string, patch: Partial<CharacterState>): void {
    charStateStore.updateCharacterState(charId, patch);
  }

  getRelationships(charId: string): CharacterRelationship[] {
    return relationshipStore.getRelationshipsFor(charId);
  }

  getRelationship(sourceCharacterId: string, targetCharacterId: string): CharacterRelationship | null {
    return relationshipStore.getRelationship(sourceCharacterId, targetCharacterId);
  }

  adjustRelationship(
    sourceCharacterId: string,
    targetCharacterId: string,
    delta: Partial<Record<"familiarity" | "affinity" | "trust" | "fear" | "conflict" | "debt", number>>,
    note?: string,
  ): void {
    relationshipStore.adjustRelationship(sourceCharacterId, targetCharacterId, delta, note);
  }

  getRelationshipSummary(sourceCharacterId: string, targetIds: string[]): string {
    const lines = targetIds
      .map((targetId) => {
        const rel = relationshipStore.getRelationship(sourceCharacterId, targetId);
        const profile = this.profiles.get(targetId);
        if (!rel || !profile) return null;
        const parts = [
          `熟悉度${Math.round(rel.familiarity)}`,
          `好感${Math.round(rel.affinity)}`,
          `信任${Math.round(rel.trust)}`,
        ];
        if (rel.fear > 0) parts.push(`畏惧${Math.round(rel.fear)}`);
        if (rel.conflict > 0) parts.push(`冲突${Math.round(rel.conflict)}`);
        if (rel.debt !== 0) parts.push(`恩债${Math.round(rel.debt)}`);
        if (rel.notes) parts.push(rel.notes);
        return `- ${profile.name}：${parts.join("，")}`;
      })
      .filter((line): line is string => Boolean(line));
    return lines.length > 0 ? lines.join("\n") : "（眼前的人暂无明确关系记录）";
  }

  tickPassiveUpdate(charId: string, currentTime: GameTime): SimulationEvent[] {
    const state = this.getState(charId);
    if (!state.isAlive) return [];
    if (state.currentAction === "sleep") {
      this.tickSleepUpdate(charId, state);
      return [];
    }

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

  private tickSleepUpdate(charId: string, state: CharacterState): void {
    charStateStore.updateCharacterState(charId, {
      energy: clampRuntimeStat(state.energy + 1.2),
      hunger: clampRuntimeStat(state.hunger + 0.4),
      stress: clampRuntimeStat(state.stress - 0.6),
      emotionArousal: clampRuntimeStat(state.emotionArousal - 0.3, 1, 10),
    });
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

function initializeRelationshipGraph(profiles: CharacterProfile[]): void {
  for (const source of profiles) {
    for (const target of profiles) {
      if (source.id === target.id) continue;
      relationshipStore.initRelationship(inferInitialRelationship(source, target));
    }
  }
}

function backfillNewNeedsState(profile: CharacterProfile, initialState: CharacterState): void {
  let persisted: CharacterState;
  try {
    persisted = charStateStore.getCharacterState(profile.id);
  } catch {
    return;
  }

  const looksLikeMigrationDefault =
    persisted.energy === 80 &&
    persisted.hunger === 20 &&
    persisted.stress === 20 &&
    persisted.money === 0 &&
    !persisted.shortTermGoal;
  if (!looksLikeMigrationDefault) return;

  charStateStore.updateCharacterState(profile.id, {
    energy: initialState.energy,
    hunger: initialState.hunger,
    stress: initialState.stress,
    money: initialState.money,
    carryWeightKg: initialState.carryWeightKg,
    shortTermGoal: initialState.shortTermGoal,
  });
}

function inferInitialRelationship(
  source: CharacterProfile,
  target: CharacterProfile,
): CharacterRelationship {
  const sourceText = [
    source.backstory,
    source.coreMotivation,
    ...source.initialMemories.map((memory) => memory.content),
    ...source.family,
  ].join(" ");
  const mentionsTarget =
    sourceText.includes(target.name) ||
    sourceText.includes(target.nickname) ||
    sourceText.includes(target.role);
  const sameHome =
    !!source.homeLocation &&
    !!target.homeLocation &&
    source.homeLocation === target.homeLocation;
  const sameWork =
    !!source.workLocation &&
    !!target.workLocation &&
    source.workLocation === target.workLocation;
  const sameStart = source.startPosition === target.startPosition;

  const baseFamiliarity = mentionsTarget ? 45 : sameHome || sameWork ? 32 : sameStart ? 18 : 6;
  const positive = /亲|友|帮|恩|信任|喜欢|照顾|friend|trust|help|care/i.test(sourceText);
  const negative = /仇|恨|怕|偷|骗|冲突|怀疑|enemy|fear|hate|stole|suspect/i.test(sourceText);

  return {
    sourceCharacterId: source.id,
    targetCharacterId: target.id,
    familiarity: baseFamiliarity,
    affinity: positive ? 24 : negative ? -18 : hashInt(`${source.id}:${target.id}:affinity`, 17) - 8,
    trust: positive ? 18 : negative ? -22 : hashInt(`${source.id}:${target.id}:trust`, 15) - 7,
    fear: /怕|惧|威胁|fear|threat/i.test(sourceText) ? 20 : 0,
    conflict: negative ? 22 : 0,
    debt: /恩|欠|债|debt|owe/i.test(sourceText) ? 12 : 0,
    notes: mentionsTarget ? "已有背景关联" : "",
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
    sleepWakeTime: null,
    emotionValence: 1,
    emotionArousal: clampStat(3 + profile.extraversionLevel * 2),
    curiosity: clampStat(64 + profile.intuitionLevel * 20),
    ...buildInitialNeedsState(profile),
    ...buildInitialLifeState(profile),
    dailyPlan: null,
  };
}

function clampStat(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampRuntimeStat(value: number, min = 0, max = 100): number {
  const clamped = Math.max(min, Math.min(max, value));
  return Math.round(clamped * 10) / 10;
}

function getSleepRecoveryPatch(state: CharacterState): Partial<CharacterState> {
  return {
    energy: clampStat(state.energy + 28),
    hunger: clampStat(state.hunger + 10),
    stress: clampStat(state.stress - 12),
  };
}

function buildWakeEvent(
  charId: string,
  location: string,
  wakeTime: string,
  gameTime: GameTime,
): SimulationEvent {
  return {
    id: generateId(),
    gameDay: gameTime.day,
    gameTick: gameTime.tick,
    type: "action_end",
    actorId: charId,
    location,
    data: {
      action: "sleep",
      actionName: "醒来",
      wakeTime,
    },
    tags: ["sleep", "wake"],
  };
}

function buildInitialNeedsState(profile: CharacterProfile): Pick<
  CharacterState,
  "energy" | "hunger" | "stress" | "money" | "carryWeightKg" | "shortTermGoal"
> {
  const age = inferInitialAge(profile);
  const text = `${profile.name} ${profile.role} ${profile.socialClass ?? ""} ${profile.backstory ?? ""} ${profile.tags.join(" ")}`;
  const money =
    /富|掌柜|老板|商|wealth|rich|merchant|owner/i.test(text) ? 45 + hashInt(profile.id, 45)
      : /乞|贫|穷|小偷|beggar|poor|thief/i.test(text) ? hashInt(profile.id, 12)
        : 12 + hashInt(profile.id, 32);
  const ageEnergyPenalty = age >= 70 ? 18 : age >= 55 ? 8 : 0;
  return {
    energy: clampStat(82 - ageEnergyPenalty + hashInt(`${profile.id}:energy`, 12)),
    hunger: clampStat(18 + hashInt(`${profile.id}:hunger`, 18)),
    stress: clampStat(
      (/债|怕|失窃|逃|嫌疑|trouble|debt|fear|lost/i.test(text) ? 36 : 18) +
        hashInt(`${profile.id}:stress`, 18),
    ),
    money: clampStat(money),
    carryWeightKg: inferInitialCarryWeightKg(profile),
    shortTermGoal: profile.longTermGoals[0] ?? profile.coreMotivation ?? null,
  };
}

function inferInitialCarryWeightKg(profile: CharacterProfile): number {
  if (typeof profile.carryWeightKg === "number" && Number.isFinite(profile.carryWeightKg)) {
    return Math.max(0, Math.round(profile.carryWeightKg * 10) / 10);
  }
  return 0;
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
  if (state.hunger >= 92) healthDelta -= 4;
  else if (state.hunger >= 78) healthDelta -= 2;
  if (state.energy <= 10) healthDelta -= 2;
  if (state.stress >= 88) healthDelta -= 2;

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
      energy: clampStat(state.energy + 8),
      hunger: clampStat(state.hunger - 22),
      stress: clampStat(state.stress - 6),
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
