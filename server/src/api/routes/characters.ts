import { Router } from "express";
import type { Request, Response } from "express";
import { appContext } from "../../services/app-context.js";
import { getEmotionLabel } from "../../core/emotion-manager.js";
import { CharacterManager } from "../../core/character-manager.js";
import { resolveActionLabel } from "../../utils/action-labels.js";

const router = Router();

// GET /characters
router.get("/", (_req, res) => {
  const profiles = appContext.characterManager.getAliveProfiles();
  const result = profiles.map((p) => {
    const s = appContext.characterManager.getState(p.id);
    const currentActionLabel = resolveActionLabel({
      actionId: s.currentAction,
      targetId: s.currentActionTarget,
      locationId: s.location,
      getWorldAction: (actionId) => appContext.worldManager.getWorldAction(actionId),
      getLocationObjects: (locationId) => appContext.worldManager.getLocationObjects(locationId),
    });
    return {
      id: p.id,
      name: p.name,
      role: p.role,
      nickname: p.nickname,
      location: s.location,
      mainAreaPointId: s.mainAreaPointId,
	      emotion: getEmotionLabel(s.emotionValence, s.emotionArousal),
	      currentAction: s.currentAction,
	      currentActionLabel,
	      ageYears: s.ageYears,
	      lifeStage: s.lifeStage,
	      lifeStageLabel: getLifeStageLabel(s.lifeStage),
	      health: s.health,
	      bodyCondition: s.bodyCondition,
	      bodyConditionLabel: getBodyConditionLabel(s.bodyCondition),
	      energy: s.energy,
		      hunger: s.hunger,
		      stress: s.stress,
		      money: s.money,
		      carryWeightKg: s.carryWeightKg,
		      shortTermGoal: s.shortTermGoal,
	      isAlive: s.isAlive,
	      anchor: p.anchor || null,
	      socialClass: p.socialClass,
	      occupation: p.occupation,
	    };
	  });
  res.json(result);
});

// GET /characters/:id
router.get("/:id", (req, res) => {
  try {
    const profile = appContext.characterManager.getProfile(req.params.id);
    const state = appContext.characterManager.getState(req.params.id);
    const currentActionLabel = resolveActionLabel({
      actionId: state.currentAction,
      targetId: state.currentActionTarget,
      locationId: state.location,
      getWorldAction: (actionId) => appContext.worldManager.getWorldAction(actionId),
      getLocationObjects: (locationId) => appContext.worldManager.getLocationObjects(locationId),
    });
    res.json({
      profile,
	      state: {
	        ...state,
	        currentActionLabel,
	        lifeStageLabel: getLifeStageLabel(state.lifeStage),
	        bodyConditionLabel: getBodyConditionLabel(state.bodyCondition),
	      },
      emotionLabel: getEmotionLabel(state.emotionValence, state.emotionArousal),
      relationships: appContext.characterManager.getRelationships(req.params.id),
    });
  } catch {
    res.status(404).json({ error: "Character not found" });
  }
});

// GET /characters/:id/diary
router.get("/:id/diary", (req, res) => {
  const gameDay = req.query.day ? Number(req.query.day) : undefined;
  const entries = appContext.characterManager.getDiaryEntries(
    req.params.id,
    gameDay,
  );
  res.json(entries);
});

// PATCH /characters/:id/profile
router.patch("/:id/profile", (req: Request, res: Response) => {
  const charId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    appContext.characterManager.getProfile(charId);
  } catch {
    return res.status(404).json({ error: "Character not found" });
  }
  const patch = req.body ?? {};
  const allowed = CharacterManager.EDITABLE_FIELDS as readonly string[];
  const unknown = Object.keys(patch).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    return res.status(400).json({ error: `Non-editable fields: ${unknown.join(", ")}` });
  }
  const updated = appContext.characterManager.patchProfile(charId, patch);
  res.json({ ok: true, profile: updated });
});

// PATCH /characters/:id/runtime-state
router.patch("/:id/runtime-state", (req: Request, res: Response) => {
  const charId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    appContext.characterManager.getProfile(charId);
  } catch {
    return res.status(404).json({ error: "Character not found" });
  }

  const { mainAreaPointId, carryWeightKg } = req.body ?? {};
  if (mainAreaPointId !== undefined && mainAreaPointId !== null && typeof mainAreaPointId !== "string") {
    return res.status(400).json({ error: "mainAreaPointId must be a string or null" });
  }
  if (
    carryWeightKg !== undefined &&
    (typeof carryWeightKg !== "number" || !Number.isFinite(carryWeightKg) || carryWeightKg < 0)
  ) {
    return res.status(400).json({ error: "carryWeightKg must be a non-negative number" });
  }

  const patch: { mainAreaPointId?: string | null; carryWeightKg?: number } = {};
  if (mainAreaPointId !== undefined) patch.mainAreaPointId = mainAreaPointId ?? null;
  if (carryWeightKg !== undefined) patch.carryWeightKg = carryWeightKg;
  appContext.characterManager.updateState(charId, patch);
  const state = appContext.characterManager.getState(charId);
  res.json({ ok: true, state });
});

// GET /characters/:id/memories — public memories (limited, excludes internal tags)
router.get("/:id/memories", (req, res) => {
  const memories = appContext.characterManager.memoryManager.getRecentMemories(
    req.params.id,
    20,
  );
  const result = memories.map((m) => ({
    content: m.content,
    gameDay: m.gameDay,
    type: m.type,
  }));
  res.json(result);
});

export default router;

function getLifeStageLabel(stage: string): string {
  if (stage === "child") return "儿童";
  if (stage === "teen") return "少年";
  if (stage === "elder") return "老年";
  return "成年";
}

function getBodyConditionLabel(condition: string): string {
  if (condition === "tired") return "疲惫";
  if (condition === "sick") return "生病";
  if (condition === "injured") return "受伤";
  if (condition === "critical") return "危重";
  if (condition === "dead") return "死亡";
  return "健康";
}
