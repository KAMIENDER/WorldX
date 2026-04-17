import type { LLMClient } from "../llm/llm-client.js";
import type { PromptBuilder } from "../llm/prompt-builder.js";
import {
  DialogueFinalizeSchema,
  DialogueTurnSchema,
} from "../llm/output-schemas.js";
import type { CharacterManager } from "../core/character-manager.js";
import type { WorldManager } from "../core/world-manager.js";
import { updateEmotion } from "../core/emotion-manager.js";
import type {
  DialogueResult,
  DialogueSession,
  DialogueTurnGeneration,
  GameTime,
} from "../types/index.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class DialogueGenerator {
  constructor(
    private llmClient: LLMClient,
    private promptBuilder: PromptBuilder,
    private characterManager: CharacterManager,
    private worldManager: WorldManager,
  ) {}

  async generateNextTurn(params: {
    session: DialogueSession;
    gameTime: GameTime;
  }): Promise<DialogueTurnGeneration> {
    const { session, gameTime } = params;
    const context = this.buildDialogueContext(session, gameTime);
    const remainingTurns = Math.max(0, session.maxTurns - session.totalTurns);

    try {
      const messages = this.promptBuilder.buildDialogueTurnMessages({
        participants: context.participants,
        location: context.locationName,
        initiatorId: session.initiatorId,
        initiatorMotivation: session.motivation,
        gameTime,
        transcript: session.transcript,
        nextSpeaker: session.nextSpeaker,
        maxTurns: session.maxTurns,
        remainingTurns,
        hearsayA: context.hearsayA,
        hearsayB: context.hearsayB,
      });

      const result = await this.llmClient.call({
        messages,
        schema: DialogueTurnSchema,
        options: { taskType: "dialogue_turn", characterId: session.nextSpeaker },
      });

      const llmOutput = result.data;
      const normalizedSpeaker = this.normalizeSpeaker(
        llmOutput.speaker,
        context.profileA,
        context.profileB,
        session.nextSpeaker,
      );
      const fallbackNextSpeaker =
        normalizedSpeaker === context.profileA.id
          ? context.profileB.id
          : context.profileA.id;

      const innerMonologue =
        typeof llmOutput.innerMonologue === "string" && llmOutput.innerMonologue.trim().length > 0
          ? llmOutput.innerMonologue.trim()
          : undefined;

      return {
        turn: {
          speaker: normalizedSpeaker,
          content: llmOutput.content,
          ...(innerMonologue ? { innerMonologue } : {}),
        },
        shouldContinue: llmOutput.shouldContinue && remainingTurns > 1,
        suggestedNextSpeaker: this.normalizeSpeaker(
          llmOutput.suggestedNextSpeaker,
          context.profileA,
          context.profileB,
          fallbackNextSpeaker,
        ),
        endReason: llmOutput.endReason,
        tags: llmOutput.tags || [],
      };
    } catch {
      const fallbackSpeaker = session.nextSpeaker;
      return {
        turn: {
          speaker: fallbackSpeaker,
          content: "嗯，先聊到这里吧。",
        },
        shouldContinue: false,
        suggestedNextSpeaker: undefined,
        endReason: "模型调用失败，提前结束对话",
        tags: ["fallback"],
      };
    }
  }

  async finalizeDialogueSession(params: {
    session: DialogueSession;
    gameTime: GameTime;
  }): Promise<DialogueResult> {
    const { session, gameTime } = params;
    const context = this.buildDialogueContext(session, gameTime);

    try {
      const messages = this.promptBuilder.buildDialogueFinalizeMessages({
        participants: context.participants,
        location: context.locationName,
        initiatorId: session.initiatorId,
        initiatorMotivation: session.motivation,
        gameTime,
        transcript: session.transcript,
        endReason: session.endReason,
      });

      const result = await this.llmClient.call({
        messages,
        schema: DialogueFinalizeSchema,
        options: {
          taskType: "dialogue_finalize",
          characterId: session.initiatorId,
        },
      });

      return await this.applyFinalization({
        session,
        gameTime,
        locationName: context.locationName,
        profileA: context.profileA,
        profileB: context.profileB,
        stateA: context.stateA,
        llmOutput: result.data,
      });
    } catch {
      return await this.applyFinalization({
        session,
        gameTime,
        locationName: context.locationName,
        profileA: context.profileA,
        profileB: context.profileB,
        stateA: context.stateA,
        llmOutput: {
          memoriesGenerated: {},
          relationshipDeltas: {},
          tags: ["fallback"],
          endReason: session.endReason ?? "模型收尾失败，已强制结束",
        },
      });
    }
  }

  private buildDialogueContext(
    session: DialogueSession,
    gameTime: GameTime,
  ) {
    const [initiatorId, responderId] = session.participants;
    const profileA = this.characterManager.getProfile(initiatorId);
    const profileB = this.characterManager.getProfile(responderId);
    const stateA = this.characterManager.getState(initiatorId);
    const stateB = this.characterManager.getState(responderId);

    const relAB =
      this.characterManager.relationshipManager.getRelationship(
        initiatorId,
        responderId,
      ) ?? {
        characterId: initiatorId,
        targetId: responderId,
        familiarity: 0,
        trust: 0,
        affection: 0,
        respect: 0,
        tension: 0,
        romanticFlag: false,
      };
    const relBA =
      this.characterManager.relationshipManager.getRelationship(
        responderId,
        initiatorId,
      ) ?? {
        characterId: responderId,
        targetId: initiatorId,
        familiarity: 0,
        trust: 0,
        affection: 0,
        respect: 0,
        tension: 0,
        romanticFlag: false,
      };

    const memoriesA = this.characterManager.memoryManager.retrieveMemories({
      characterId: initiatorId,
      currentTime: gameTime,
      contextKeywords: [profileB.name, profileB.id],
      relatedCharacterIds: [responderId],
      topK: 5,
    });
    const memoriesB = this.characterManager.memoryManager.retrieveMemories({
      characterId: responderId,
      currentTime: gameTime,
      contextKeywords: [profileA.name, profileA.id],
      relatedCharacterIds: [initiatorId],
      topK: 5,
    });

    const memoriesAtext =
      memoriesA.length > 0
        ? memoriesA.map((m) => `- ${m.content}`).join("\n")
        : "";
    const memoriesBtext =
      memoriesB.length > 0
        ? memoriesB.map((m) => `- ${m.content}`).join("\n")
        : "";

    const location = this.worldManager.getLocation(stateA.location);
    const locationName = location?.name ?? stateA.location;

    const hearsayA = this.characterManager.memoryManager
      .getRecentHearsay(initiatorId, gameTime.day)
      .map((m) => `- ${m.content}`)
      .join("\n");
    const hearsayB = this.characterManager.memoryManager
      .getRecentHearsay(responderId, gameTime.day)
      .map((m) => `- ${m.content}`)
      .join("\n");

    return {
      initiatorId,
      responderId,
      profileA,
      profileB,
      stateA,
      stateB,
      locationName,
      hearsayA,
      hearsayB,
      participants: [
        {
          profile: profileA,
          state: stateA,
          memoriesAboutOther: memoriesAtext,
          relationship: relAB,
        },
        {
          profile: profileB,
          state: stateB,
          memoriesAboutOther: memoriesBtext,
          relationship: relBA,
        },
      ],
    };
  }

  private async applyFinalization(params: {
    session: DialogueSession;
    gameTime: GameTime;
    locationName: string;
    profileA: { id: string; name: string };
    profileB: { id: string; name: string };
    stateA: { location: string };
    llmOutput: {
      memoriesGenerated: Record<string, string>;
      relationshipDeltas: Record<string, Record<string, number | undefined>>;
      tags: string[];
      endReason?: string;
      hearsayGenerated?: Record<string, string>;
    };
  }): Promise<DialogueResult> {
    const { session, gameTime, locationName, profileA, profileB, stateA, llmOutput } =
      params;
    const [initiatorId, responderId] = session.participants;

    const deltasForA: Record<string, number> = {};
    const deltasForB: Record<string, number> = {};

    for (const [key, delta] of Object.entries(llmOutput.relationshipDeltas || {})) {
      const lk = key.toLowerCase();
      let target: Record<string, number>;

      if (
        key === initiatorId ||
        key === profileA.name ||
        lk.includes("a_to") ||
        lk.includes("a→")
      ) {
        target = deltasForA;
      } else if (
        key === responderId ||
        key === profileB.name ||
        lk.includes("b_to") ||
        lk.includes("b→")
      ) {
        target = deltasForB;
      } else {
        target = Object.keys(deltasForA).length === 0 ? deltasForA : deltasForB;
      }

      for (const [dim, val] of Object.entries(delta)) {
        if (val !== undefined) {
          target[dim] = clamp(val, -15, 15);
        }
      }
    }

    const memA =
      llmOutput.memoriesGenerated?.[initiatorId] ??
      llmOutput.memoriesGenerated?.[profileA.name] ??
      `和${profileB.name}聊了几句`;
    const memB =
      llmOutput.memoriesGenerated?.[responderId] ??
      llmOutput.memoriesGenerated?.[profileB.name] ??
      `和${profileA.name}聊了几句`;
    const tags = Array.from(
      new Set(["dialogue", ...session.tags, ...(llmOutput.tags || [])]),
    );

    this.characterManager.memoryManager.addMemory({
      characterId: initiatorId,
      type: "conversation",
      content: memA,
      gameTime,
      importance: 5,
      emotionalValence: 1,
      emotionalIntensity: 3,
      relatedCharacters: [responderId],
      relatedLocation: stateA.location,
      tags,
    });

    this.characterManager.memoryManager.addMemory({
      characterId: responderId,
      type: "conversation",
      content: memB,
      gameTime,
      importance: 5,
      emotionalValence: 1,
      emotionalIntensity: 3,
      relatedCharacters: [initiatorId],
      relatedLocation: stateA.location,
      tags,
    });

    if (llmOutput.hearsayGenerated) {
      for (const [charId, hearsayContent] of Object.entries(llmOutput.hearsayGenerated)) {
        const resolvedId =
          charId === profileA.id || charId === profileA.name
            ? initiatorId
            : charId === profileB.id || charId === profileB.name
              ? responderId
              : charId;
        const sourceId = resolvedId === initiatorId ? responderId : initiatorId;
        this.characterManager.memoryManager.addMemory({
          characterId: resolvedId,
          type: "hearsay",
          content: hearsayContent,
          gameTime,
          importance: 5,
          emotionalValence: 0,
          emotionalIntensity: 2,
          relatedCharacters: [sourceId],
          relatedLocation: stateA.location,
          tags: [...tags, "hearsay"],
        });
      }
    }

    if (Object.keys(deltasForA).length > 0) {
      try {
        this.characterManager.relationshipManager.updateRelationship(
          initiatorId,
          responderId,
          deltasForA,
        );
      } catch {
        // ignore missing pair
      }
    }
    if (Object.keys(deltasForB).length > 0) {
      try {
        this.characterManager.relationshipManager.updateRelationship(
          responderId,
          initiatorId,
          deltasForB,
        );
      } catch {
        // ignore missing pair
      }
    }

    this.applyDialogueEmotionShift(initiatorId, deltasForA);
    this.applyDialogueEmotionShift(responderId, deltasForB);

    return {
      participants: [initiatorId, responderId],
      location: locationName,
      turns: session.transcript,
      memoriesGenerated: { [initiatorId]: memA, [responderId]: memB },
      relationshipDeltas: {
        [initiatorId]: deltasForA,
        [responderId]: deltasForB,
      },
      tags,
      endReason: llmOutput.endReason ?? session.endReason,
    };
  }

  private applyDialogueEmotionShift(
    charId: string,
    deltas: Record<string, number>,
  ): void {
    const positive =
      (deltas.affection ?? 0) * 0.6 +
      (deltas.trust ?? 0) * 0.5 +
      (deltas.respect ?? 0) * 0.35;
    const negative = (deltas.tension ?? 0) * 0.8;
    const valence = Math.max(-2, Math.min(2, Math.round((positive - negative) / 6)));
    const intensity = Math.max(
      1,
      Math.min(
        5,
        Math.round(
          (Math.abs(deltas.affection ?? 0) +
            Math.abs(deltas.trust ?? 0) +
            Math.abs(deltas.respect ?? 0) +
            Math.abs(deltas.tension ?? 0)) / 6,
        ),
      ),
    );

    if (valence === 0 && intensity <= 1) return;

    const state = this.characterManager.getState(charId);
    const next = updateEmotion(
      {
        valence: state.emotionValence,
        arousal: state.emotionArousal,
      },
      {
        valence,
        intensity,
      },
    );
    this.characterManager.updateState(charId, {
      emotionValence: next.valence,
      emotionArousal: next.arousal,
    });
  }

  private normalizeSpeaker(
    rawSpeaker: string | undefined,
    profileA: { id: string; name: string },
    profileB: { id: string; name: string },
    fallback: string,
  ): string {
    if (!rawSpeaker) return fallback;
    const normalized = rawSpeaker.trim();
    const nameToId: Record<string, string> = {
      [profileA.name]: profileA.id,
      [profileB.name]: profileB.id,
      [profileA.id]: profileA.id,
      [profileB.id]: profileB.id,
    };
    return nameToId[normalized] ?? fallback;
  }
}
