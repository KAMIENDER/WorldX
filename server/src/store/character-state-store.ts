import { getDb } from "./db.js";
import type { BodyCondition, CharacterState, LifeStage } from "../types/index.js";

function normalizeLifeStage(value: unknown): LifeStage {
  return value === "child" || value === "teen" || value === "elder" ? value : "adult";
}

function normalizeBodyCondition(value: unknown): BodyCondition {
  if (
    value === "healthy" ||
    value === "tired" ||
    value === "sick" ||
    value === "injured" ||
    value === "critical" ||
    value === "dead"
  ) {
    return value;
  }
  return "healthy";
}

function rowToState(row: any): CharacterState {
  return {
    characterId: row.character_id,
    location: row.location,
    mainAreaPointId: row.main_area_point_id ?? null,
    currentAction: row.current_action ?? null,
    currentActionTarget: row.current_action_target ?? null,
    actionStartTick: row.action_start_tick,
    actionEndTick: row.action_end_tick,
    emotionValence: row.emotion_valence,
    emotionArousal: row.emotion_arousal,
    curiosity: row.curiosity,
    energy: row.energy ?? 80,
    hunger: row.hunger ?? 20,
    stress: row.stress ?? 20,
    money: row.money ?? 0,
    carryWeightKg: row.carry_weight_kg ?? 0,
    shortTermGoal: row.short_term_goal ?? null,
    ageYears: row.age_years ?? 30,
    ageDays: row.age_days ?? 0,
    lifeStage: normalizeLifeStage(row.life_stage),
    health: row.health ?? 100,
    bodyCondition: normalizeBodyCondition(row.body_condition),
    isAlive: row.is_alive !== 0,
    deathDay: row.death_day ?? null,
    deathTick: row.death_tick ?? null,
    deathCause: row.death_cause ?? null,
    dailyPlan: row.daily_plan ?? null,
  };
}

export function initCharacterState(state: CharacterState): void {
  getDb()
    .prepare(
	      `INSERT OR IGNORE INTO character_states
	       (character_id, location, main_area_point_id, current_action, current_action_target,
	        action_start_tick, action_end_tick, emotion_valence, emotion_arousal,
	        curiosity, energy, hunger, stress, money, carry_weight_kg, short_term_goal,
	        age_years, age_days, life_stage, health, body_condition, is_alive,
	        death_day, death_tick, death_cause, daily_plan)
		       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	    )
	    .run(
	      state.characterId,
      state.location,
      state.mainAreaPointId,
      state.currentAction,
      state.currentActionTarget,
      state.actionStartTick,
      state.actionEndTick,
	      state.emotionValence,
	      state.emotionArousal,
	      state.curiosity,
	      state.energy,
	      state.hunger,
      state.stress,
      state.money,
      state.carryWeightKg,
      state.shortTermGoal,
	      state.ageYears,
	      state.ageDays,
	      state.lifeStage,
	      state.health,
	      state.bodyCondition,
	      state.isAlive ? 1 : 0,
	      state.deathDay,
	      state.deathTick,
	      state.deathCause,
	      state.dailyPlan,
	    );
}

export function getCharacterState(id: string): CharacterState {
  const row = getDb()
    .prepare("SELECT * FROM character_states WHERE character_id = ?")
    .get(id) as any;
  if (!row) throw new Error(`Character state not found: ${id}`);
  return rowToState(row);
}

export function getAllCharacterStates(): CharacterState[] {
  return (getDb().prepare("SELECT * FROM character_states").all() as any[]).map(rowToState);
}

export function updateCharacterState(id: string, patch: Partial<CharacterState>): void {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.location !== undefined) {
    sets.push("location = ?");
    params.push(patch.location);
  }
  if (patch.mainAreaPointId !== undefined) {
    sets.push("main_area_point_id = ?");
    params.push(patch.mainAreaPointId);
  }
  if (patch.currentAction !== undefined) {
    sets.push("current_action = ?");
    params.push(patch.currentAction);
  }
  if (patch.currentActionTarget !== undefined) {
    sets.push("current_action_target = ?");
    params.push(patch.currentActionTarget);
  }
  if (patch.actionStartTick !== undefined) {
    sets.push("action_start_tick = ?");
    params.push(patch.actionStartTick);
  }
  if (patch.actionEndTick !== undefined) {
    sets.push("action_end_tick = ?");
    params.push(patch.actionEndTick);
  }
  if (patch.emotionValence !== undefined) {
    sets.push("emotion_valence = ?");
    params.push(patch.emotionValence);
  }
  if (patch.emotionArousal !== undefined) {
    sets.push("emotion_arousal = ?");
    params.push(patch.emotionArousal);
  }
  if (patch.curiosity !== undefined) {
    sets.push("curiosity = ?");
    params.push(patch.curiosity);
  }
  if (patch.energy !== undefined) {
    sets.push("energy = ?");
    params.push(patch.energy);
  }
  if (patch.hunger !== undefined) {
    sets.push("hunger = ?");
    params.push(patch.hunger);
  }
  if (patch.stress !== undefined) {
    sets.push("stress = ?");
    params.push(patch.stress);
  }
  if (patch.money !== undefined) {
    sets.push("money = ?");
    params.push(patch.money);
  }
  if (patch.carryWeightKg !== undefined) {
    sets.push("carry_weight_kg = ?");
    params.push(patch.carryWeightKg);
  }
  if (patch.shortTermGoal !== undefined) {
    sets.push("short_term_goal = ?");
    params.push(patch.shortTermGoal);
  }
  if (patch.ageYears !== undefined) {
    sets.push("age_years = ?");
    params.push(patch.ageYears);
  }
  if (patch.ageDays !== undefined) {
    sets.push("age_days = ?");
    params.push(patch.ageDays);
  }
  if (patch.lifeStage !== undefined) {
    sets.push("life_stage = ?");
    params.push(patch.lifeStage);
  }
  if (patch.health !== undefined) {
    sets.push("health = ?");
    params.push(patch.health);
  }
  if (patch.bodyCondition !== undefined) {
    sets.push("body_condition = ?");
    params.push(patch.bodyCondition);
  }
  if (patch.isAlive !== undefined) {
    sets.push("is_alive = ?");
    params.push(patch.isAlive ? 1 : 0);
  }
  if (patch.deathDay !== undefined) {
    sets.push("death_day = ?");
    params.push(patch.deathDay);
  }
  if (patch.deathTick !== undefined) {
    sets.push("death_tick = ?");
    params.push(patch.deathTick);
  }
  if (patch.deathCause !== undefined) {
    sets.push("death_cause = ?");
    params.push(patch.deathCause);
  }
  if (patch.dailyPlan !== undefined) {
    sets.push("daily_plan = ?");
    params.push(patch.dailyPlan);
  }

  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  params.push(id);

  getDb()
    .prepare(`UPDATE character_states SET ${sets.join(", ")} WHERE character_id = ?`)
    .run(...params);
}

export function getCharactersByLocation(locationId: string): CharacterState[] {
  return (
    getDb()
      .prepare("SELECT * FROM character_states WHERE location = ?")
      .all(locationId) as any[]
  ).map(rowToState);
}
