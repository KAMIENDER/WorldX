import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { appContext } from "../../services/app-context.js";
import { buildPerception } from "../../simulation/perceiver.js";
import { executeAction } from "../../simulation/action-executor.js";
import * as eventStore from "../../store/event-store.js";
import { generateId } from "../../utils/id-generator.js";
import type { ActionDecision, DialogueTurn, GameTime, SimulationEvent } from "../../types/index.js";

type PossessionActionCategory = "world" | "object" | "talk" | "move" | "rest";

interface PossessionSession {
  id: string;
  actorId: string;
  targetId: string;
  createdAt: number;
  lastActiveAt: number;
  contextLines: string[];
  history: Array<{ speakerId: string; speakerName: string; content: string }>;
}

interface PossessionActionOption {
  id: string;
  category: PossessionActionCategory;
  actionType: ActionDecision["actionType"];
  label: string;
  targetId: string;
  interactionId?: string;
  disabled?: boolean;
}

const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_HISTORY = 40;
const MAX_SESSIONS = 64;
const sessions = new Map<string, PossessionSession>();

const ReplySchema = z.object({ reply: z.string().min(1) });

const ActionSchema = z.object({
  characterId: z.string().min(1),
  actionType: z.enum(["interact_object", "world_action", "talk_to", "move_to", "move_within_main_area", "idle", "sleep"]),
  targetId: z.string().min(1),
  interactionId: z.string().optional(),
  wakeTime: z.string().optional(),
  reason: z.string().optional(),
});

const router = Router();

router.get("/context", (req: Request, res: Response) => {
  const characterId = getQueryString(req.query.characterId);
  const targetId = getQueryString(req.query.targetId);
  if (!characterId) return res.status(400).json({ error: "characterId is required" });

  try {
    const profile = appContext.characterManager.getProfile(characterId);
    const state = appContext.characterManager.getState(characterId);
    if (!state.isAlive) return res.status(410).json({ error: "character is dead" });

    const gameTime = appContext.worldManager.getCurrentTime();
    const perception = buildPerception(characterId, appContext.worldManager, appContext.characterManager, gameTime);
    const location = appContext.worldManager.getLocation(state.location);
    const nearbyCharacters = perception.charactersHere.map((character) => ({
      id: character.id,
      name: character.name,
      currentAction: character.currentAction,
      emotionLabel: character.emotionLabel,
      bodyCondition: character.bodyCondition,
      locationId: character.locationId,
      locationName: character.locationName,
      zone: character.zone,
    }));

    return res.json({
      ok: true,
      gameTime,
      actor: {
        id: profile.id,
        name: profile.name,
        role: profile.role,
        occupation: profile.occupation,
        speakingStyle: profile.speakingStyle,
      },
      state,
      location: {
        id: state.location,
        name: location?.name ?? state.location,
        description: location?.description ?? "",
        zone: perception.myZone,
      },
      nearbyCharacters,
      recentActions: perception.recentActions,
      recentEnvironmentChanges: perception.recentEnvironmentChanges,
      recentDialogueContext: targetId ? getRecentDialogueContext(characterId, targetId) : [],
      actions: buildActionOptions(characterId),
    });
  } catch (error) {
    return res.status(404).json({ error: error instanceof Error ? error.message : "character not found" });
  }
});

router.post("/action", (req: Request, res: Response) => {
  const parsed = ActionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((issue) => issue.message).join("; ") });
  }

  const body = parsed.data;
  try {
    appContext.characterManager.getProfile(body.characterId);
  } catch {
    return res.status(404).json({ error: "character not found" });
  }

  const state = appContext.characterManager.getState(body.characterId);
  if (!state.isAlive) return res.status(410).json({ error: "character is dead" });
  if (state.currentAction && state.currentAction !== "idle" && state.currentAction !== "post_dialogue") {
    return res.status(409).json({ error: `character is busy: ${state.currentAction}` });
  }

  const decision: ActionDecision = {
    actionType: body.actionType,
    targetId: body.targetId,
    interactionId: body.interactionId,
    wakeTime: body.wakeTime,
    reason: body.reason?.trim() || "玩家附身控制",
    innerMonologue: "有一种外来的意志短暂接管了我的行动。",
  };

  const gameTime = appContext.worldManager.getCurrentTime();
  const events = executeAction(
    decision,
    body.characterId,
    appContext.worldManager,
    appContext.characterManager,
    gameTime,
  );
  if (events.length === 0) {
    return res.status(400).json({ error: "action could not be executed" });
  }

  eventStore.appendEvents(events);
  appContext.eventBus.emit("tick_events", { gameTime, events });

  return res.json({
    ok: true,
    events,
    state: appContext.characterManager.getState(body.characterId),
  });
});

router.post("/chat/start", (req: Request, res: Response) => {
  reapExpired();
  const { actorId, targetId } = req.body ?? {};
  if (typeof actorId !== "string" || actorId.trim().length === 0) {
    return res.status(400).json({ error: "actorId is required" });
  }
  if (typeof targetId !== "string" || targetId.trim().length === 0) {
    return res.status(400).json({ error: "targetId is required" });
  }
  if (actorId === targetId) return res.status(400).json({ error: "target must be another character" });

  const validation = validateConversationPair(actorId, targetId);
  if (!validation.ok) return res.status(validation.status).json({ error: validation.error });

  const id = generateId();
  const now = Date.now();
  const session: PossessionSession = {
    id,
    actorId,
    targetId,
    createdAt: now,
    lastActiveAt: now,
    contextLines: getRecentDialogueContext(actorId, targetId),
    history: [],
  };
  sessions.set(id, session);

  const actor = appContext.characterManager.getProfile(actorId);
  const target = appContext.characterManager.getProfile(targetId);
  return res.json({
    ok: true,
    sessionId: id,
    actor: { id: actor.id, name: actor.name, role: actor.role },
    target: { id: target.id, name: target.name, role: target.role },
    contextLines: session.contextLines,
    history: session.history,
  });
});

router.post("/chat/message", async (req: Request, res: Response) => {
  reapExpired();
  const { sessionId, message } = req.body ?? {};
  if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
    return res.status(404).json({ error: "session not found" });
  }
  if (typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "message is required" });
  }

  const session = sessions.get(sessionId)!;
  const validation = validateConversationPair(session.actorId, session.targetId);
  if (!validation.ok) {
    sessions.delete(sessionId);
    return res.status(validation.status).json({ error: validation.error });
  }

  const userMsg = message.trim();
  const targetProfile = appContext.characterManager.getProfile(session.targetId);
  const actorProfile = appContext.characterManager.getProfile(session.actorId);
  const targetState = appContext.characterManager.getState(session.targetId);
  const gameTime = appContext.worldManager.getCurrentTime();
  const keywordSource = [
    userMsg,
    ...session.contextLines,
    ...session.history.slice(-6).map((h) => h.content),
  ].join(" ");
  const contextKeywords = keywordSource
    .split(/[\s，。！？,.!?；;:：]+/)
    .filter((k) => k.length >= 2)
    .slice(0, 24);
  const memories = await appContext.characterManager.memoryManager.retrieveMemoriesAsync({
    characterId: session.targetId,
    currentTime: gameTime,
    contextKeywords,
    relatedLocation: targetState.location,
    topK: 8,
  });
  const memoriesBlock = [
    ...session.contextLines.map((line) => `[既有对话] ${line}`),
    ...memories.map((memory) => `- ${memory.content}`),
  ].join("\n");
  const transcript = session.history.map((item) => ({
    role: item.speakerId === session.actorId ? "user" as const : "character" as const,
    content: item.content,
  }));

  const messages = appContext.promptBuilder.buildSandboxChatMessages({
    profile: targetProfile,
    state: targetState,
    memoriesBlock,
    userIdentity: `对方是${actorProfile.name}（${actorProfile.role}）。他此刻正被玩家附身并直接控制说话与行动。你必须把对方视为世界内的${actorProfile.name}，不要意识到玩家或系统。`,
    transcript,
    latestUserMessage: userMsg,
  });

  try {
    const result = await appContext.llmClient.call({
      messages,
      schema: ReplySchema,
      options: {
        taskType: "possession_chat",
        characterId: session.targetId,
        temperature: 0.85,
      },
    });
    const reply = result.data.reply.trim();
    const turnIndexStart = session.history.length;
    session.history.push({ speakerId: actorProfile.id, speakerName: actorProfile.name, content: userMsg });
    session.history.push({ speakerId: targetProfile.id, speakerName: targetProfile.name, content: reply });
    if (session.history.length > MAX_HISTORY) {
      session.history.splice(0, session.history.length - MAX_HISTORY);
    }
    session.lastActiveAt = Date.now();

    const event = buildPossessionDialogueEvent({
      sessionId: session.id,
      actorId: actorProfile.id,
      targetId: targetProfile.id,
      location: targetState.location,
      gameTime,
      turnIndexStart,
      turns: [
        { speaker: actorProfile.id, content: userMsg },
        { speaker: targetProfile.id, content: reply },
      ],
    });
    eventStore.appendEvent(event);
    appContext.eventBus.emit("tick_events", { gameTime, events: [event] });

    return res.json({
      ok: true,
      reply,
      event,
      history: session.history,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: `LLM call failed: ${msg}` });
  }
});

router.get("/chat/:sessionId", (req: Request, res: Response) => {
  const sessionId = Array.isArray(req.params.sessionId)
    ? req.params.sessionId[0]
    : req.params.sessionId;
  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "session not found" });
  return res.json({
    ok: true,
    sessionId,
    actorId: session.actorId,
    targetId: session.targetId,
    contextLines: session.contextLines,
    history: session.history,
  });
});

router.post("/chat/close", (req: Request, res: Response) => {
  const { sessionId } = req.body ?? {};
  if (typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }
  sessions.delete(sessionId);
  return res.json({ ok: true });
});

export default router;

function buildActionOptions(characterId: string): PossessionActionOption[] {
  const state = appContext.characterManager.getState(characterId);
  const profile = appContext.characterManager.getProfile(characterId);
  const isBusy = !!state.currentAction && state.currentAction !== "idle" && state.currentAction !== "post_dialogue";
  if (isBusy || profile.anchor) {
    return [
      {
        id: "idle",
        category: "rest",
        actionType: "idle",
        label: isBusy ? `当前忙于：${state.currentAction}` : "原地停留",
        targetId: state.location,
        disabled: isBusy,
      },
    ];
  }

  const options: PossessionActionOption[] = [];

  for (const action of appContext.worldManager.getWorldActions()) {
    options.push({
      id: `world:${action.id}`,
      category: "world",
      actionType: "world_action",
      label: action.name,
      targetId: action.id,
    });
  }

  for (const object of appContext.worldManager.getLocationObjects(state.location)) {
    if (object.currentUsers.length >= object.capacity) continue;
    for (const interaction of appContext.worldManager.getAvailableInteractions(object.id)) {
      if (interaction.requiresAnchor) continue;
      options.push({
        id: `object:${object.id}:${interaction.id}`,
        category: "object",
        actionType: "interact_object",
        label: `${object.name} · ${interaction.name}`,
        targetId: object.id,
        interactionId: interaction.id,
      });
    }
  }

  const perception = buildPerception(
    characterId,
    appContext.worldManager,
    appContext.characterManager,
    appContext.worldManager.getCurrentTime(),
  );
  for (const character of perception.charactersHere) {
    const targetState = appContext.characterManager.getState(character.id);
    if (targetState.currentAction === "sleep" || targetState.currentAction === "in_conversation") continue;
    options.push({
      id: `talk:${character.id}`,
      category: "talk",
      actionType: "talk_to",
      label: `和${character.name}说话`,
      targetId: character.id,
    });
  }

  if (state.location === "main_area" && appContext.worldManager.hasMultipleMainAreaPoints()) {
    const zones = appContext.worldManager.getAvailableMainAreaZones();
    const currentZone = appContext.worldManager.getMainAreaPointZone(state.mainAreaPointId);
    for (const zone of zones) {
      if (zone === currentZone) continue;
      options.push({
        id: `move:main_area:${zone}`,
        category: "move",
        actionType: "move_within_main_area",
        label: `走到主区域${zone === "中" ? "中央" : `${zone}侧`}`,
        targetId: `main_area:${zone}`,
      });
    }
  }

  for (const locationId of appContext.worldManager.getAdjacentLocations(state.location)) {
    const location = appContext.worldManager.getLocation(locationId);
    options.push({
      id: `move:${locationId}`,
      category: "move",
      actionType: "move_to",
      label: `前往${location?.name ?? locationId}`,
      targetId: locationId,
    });
  }

  options.push({
    id: "idle",
    category: "rest",
    actionType: "idle",
    label: "原地观察/思考",
    targetId: state.location,
  });
  options.push({
    id: "sleep",
    category: "rest",
    actionType: "sleep",
    label: "结束今天并休息",
    targetId: state.location,
  });

  return options;
}

function validateConversationPair(
  actorId: string,
  targetId: string,
): { ok: true } | { ok: false; status: number; error: string } {
  try {
    appContext.characterManager.getProfile(actorId);
    appContext.characterManager.getProfile(targetId);
  } catch {
    return { ok: false, status: 404, error: "character not found" };
  }
  if (!appContext.characterManager.isAlive(actorId) || !appContext.characterManager.isAlive(targetId)) {
    return { ok: false, status: 410, error: "character is dead" };
  }
  const actorState = appContext.characterManager.getState(actorId);
  const targetState = appContext.characterManager.getState(targetId);
  if (actorState.location !== targetState.location) {
    return { ok: false, status: 409, error: "characters are not in the same location" };
  }
  return { ok: true };
}

function buildPossessionDialogueEvent(params: {
  sessionId: string;
  actorId: string;
  targetId: string;
  location: string;
  gameTime: GameTime;
  turnIndexStart: number;
  turns: DialogueTurn[];
}): SimulationEvent {
  return {
    id: generateId(),
    gameDay: params.gameTime.day,
    gameTick: params.gameTime.tick,
    type: "dialogue",
    actorId: params.actorId,
    targetId: params.targetId,
    location: params.location,
    data: {
      conversationId: `possession:${params.sessionId}`,
      phase: "turn",
      turns: params.turns,
      turnIndexStart: params.turnIndexStart,
      isFinal: false,
      participants: [params.actorId, params.targetId],
    },
    tags: ["possession", "dialogue"],
  };
}

function getRecentDialogueContext(actorId: string, targetId: string): string[] {
  const latest = eventStore.getLatestEvents(200);
  const lines: string[] = [];
  for (const event of latest) {
    if (event.type !== "dialogue") continue;
    const participants = Array.isArray(event.data?.participants)
      ? event.data.participants
      : [event.actorId, event.targetId].filter(Boolean);
    if (!participants.includes(actorId) || !participants.includes(targetId)) continue;
    const turns = Array.isArray(event.data?.turns) ? event.data.turns as DialogueTurn[] : [];
    for (const turn of turns) {
      const name = safeCharacterName(turn.speaker);
      lines.push(`${name}: ${turn.content}`);
      if (lines.length >= 12) return lines.reverse();
    }
  }
  return lines.reverse();
}

function safeCharacterName(characterId: string): string {
  try {
    return appContext.characterManager.getProfile(characterId).name;
  } catch {
    return characterId;
  }
}

function reapExpired(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActiveAt > SESSION_IDLE_MS) {
      sessions.delete(id);
    }
  }
  if (sessions.size > MAX_SESSIONS) {
    const entries = [...sessions.entries()].sort(
      (a, b) => a[1].lastActiveAt - b[1].lastActiveAt,
    );
    for (const [id] of entries.slice(0, entries.length - MAX_SESSIONS)) {
      sessions.delete(id);
    }
  }
}

function getQueryString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim();
  return "";
}
