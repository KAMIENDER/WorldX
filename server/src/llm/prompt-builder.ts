import { loadPromptTemplate } from "../utils/config-loader.js";
import { tickToSceneTimeWithPeriod } from "../utils/time-helpers.js";
import type {
  CharacterProfile,
  CharacterState,
  GameTime,
  Perception,
  Relationship,
} from "../types/index.js";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

const TEMPLATE_NAMES = [
  "reactive-decision",
  "dialogue",
  "dialogue-turn",
  "dialogue-finalize",
  "diary",
  "memory-eval",
  "micro-reflection",
  "reflection",
  "sandbox-chat",
];

let initialized = false;

export class PromptBuilder {
  initialize(): void {
    for (const name of TEMPLATE_NAMES) {
      loadPromptTemplate(name);
    }
    initialized = true;
  }

  build(templateName: string, variables: Record<string, string>): string {
    const template = loadPromptTemplate(templateName);
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
      return variables[key] ?? `{{${key}}}`;
    });
  }

  buildReactiveDecisionMessages(params: {
    profile: CharacterProfile;
    state: CharacterState;
    gameTime: GameTime;
    perception: Perception;
    relevantMemories: string;
    actionMenu: string;
    currentFocus?: string;
  }): Message[] {
    const { profile, state, gameTime, perception } = params;

    const emotionLabel = getEmotionLabelSimple(
      state.emotionValence,
      state.emotionArousal,
    );
    const timeString = tickToSceneTimeWithPeriod(gameTime.tick);

    const perceptionText = formatPerception(perception);

    const content = this.build("reactive-decision", {
      name: profile.name,
      mbtiType: profile.mbtiType,
      coreTraits: profile.coreTraits.join("、"),
      speakingStyle: profile.speakingStyle,
      day: String(gameTime.day),
      timeString,
      currentLocation: perception.currentLocation,
      emotionLabel,
      currentFocus: params.currentFocus || "",
      perceptionText,
      relevantMemories: params.relevantMemories || "（无相关记忆）",
      actionMenu: params.actionMenu,
      iconicCuesBlock: formatIconicCuesBlock(profile),
    });

    return [{ role: "user", content }];
  }

  buildDialogueMessages(params: {
    participants: {
      profile: CharacterProfile;
      state: CharacterState;
      memoriesAboutOther: string;
      relationship: Relationship;
    }[];
    location: string;
    initiatorId: string;
    initiatorMotivation: string;
    gameTime: GameTime;
  }): Message[] {
    const { participants, location, initiatorId, gameTime } = params;

    const a = participants.find((p) => p.profile.id === initiatorId)!;
    const b = participants.find((p) => p.profile.id !== initiatorId)!;

    const timeString = tickToSceneTimeWithPeriod(gameTime.tick);

    const content = this.build("dialogue", {
      nameA: a.profile.name,
      mbtiA: a.profile.mbtiType,
      traitsA: a.profile.coreTraits.join("、"),
      styleA: a.profile.speakingStyle,
      emotionA: getEmotionLabelSimple(
        a.state.emotionValence,
        a.state.emotionArousal,
      ),
      familiarityAB: String(Math.round(a.relationship.familiarity)),
      affectionAB: String(Math.round(a.relationship.affection)),
      trustAB: String(Math.round(a.relationship.trust)),
      tensionAB: String(Math.round(a.relationship.tension)),
      memoriesAaboutB: a.memoriesAboutOther || "（无）",
      motivation: params.initiatorMotivation,

      nameB: b.profile.name,
      mbtiB: b.profile.mbtiType,
      traitsB: b.profile.coreTraits.join("、"),
      styleB: b.profile.speakingStyle,
      emotionB: getEmotionLabelSimple(
        b.state.emotionValence,
        b.state.emotionArousal,
      ),
      familiarityBA: String(Math.round(b.relationship.familiarity)),
      affectionBA: String(Math.round(b.relationship.affection)),
      trustBA: String(Math.round(b.relationship.trust)),
      tensionBA: String(Math.round(b.relationship.tension)),
      memoriesBaboutA: b.memoriesAboutOther || "（无）",

      location,
      day: String(gameTime.day),
      timeString,
    });

    return [{ role: "user", content }];
  }

  buildDialogueTurnMessages(params: {
    participants: {
      profile: CharacterProfile;
      state: CharacterState;
      memoriesAboutOther: string;
      relationship: Relationship;
    }[];
    location: string;
    initiatorId: string;
    initiatorMotivation: string;
    gameTime: GameTime;
    transcript: { speaker: string; content: string }[];
    nextSpeaker: string;
    totalTurns: number;
    hearsayA?: string;
    hearsayB?: string;
  }): Message[] {
    const { participants, location, initiatorId, gameTime } = params;

    const a = participants.find((p) => p.profile.id === initiatorId)!;
    const b = participants.find((p) => p.profile.id !== initiatorId)!;
    const nextSpeakerProfile = participants.find(
      (p) => p.profile.id === params.nextSpeaker,
    )?.profile;
    const timeString = tickToSceneTimeWithPeriod(gameTime.tick);

    const content = this.build("dialogue-turn", {
      nameA: a.profile.name,
      idA: a.profile.id,
      mbtiA: a.profile.mbtiType,
      traitsA: a.profile.coreTraits.join("、"),
      styleA: a.profile.speakingStyle,
      emotionA: getEmotionLabelSimple(
        a.state.emotionValence,
        a.state.emotionArousal,
      ),
      familiarityAB: String(Math.round(a.relationship.familiarity)),
      affectionAB: String(Math.round(a.relationship.affection)),
      trustAB: String(Math.round(a.relationship.trust)),
      tensionAB: String(Math.round(a.relationship.tension)),
      memoriesAaboutB: a.memoriesAboutOther || "（无）",
      hearsayA: params.hearsayA || "（无）",
      motivation: params.initiatorMotivation,

      nameB: b.profile.name,
      idB: b.profile.id,
      mbtiB: b.profile.mbtiType,
      traitsB: b.profile.coreTraits.join("、"),
      styleB: b.profile.speakingStyle,
      emotionB: getEmotionLabelSimple(
        b.state.emotionValence,
        b.state.emotionArousal,
      ),
      familiarityBA: String(Math.round(b.relationship.familiarity)),
      affectionBA: String(Math.round(b.relationship.affection)),
      trustBA: String(Math.round(b.relationship.trust)),
      tensionBA: String(Math.round(b.relationship.tension)),
      memoriesBaboutA: b.memoriesAboutOther || "（无）",
      hearsayB: params.hearsayB || "（无）",

      location,
      day: String(gameTime.day),
      timeString,
      transcript: formatTranscript(params.transcript),
      nextSpeakerId: params.nextSpeaker,
      nextSpeakerName: nextSpeakerProfile?.name ?? params.nextSpeaker,
      currentTurnCount: String(params.totalTurns),
      iconicCuesBlock: formatIconicCuesBlockForPair(a.profile, b.profile),
    });

    return [{ role: "user", content }];
  }

  buildDialogueFinalizeMessages(params: {
    participants: {
      profile: CharacterProfile;
      state: CharacterState;
      memoriesAboutOther: string;
      relationship: Relationship;
    }[];
    location: string;
    initiatorId: string;
    initiatorMotivation: string;
    gameTime: GameTime;
    transcript: { speaker: string; content: string }[];
    endReason?: string;
  }): Message[] {
    const { participants, location, initiatorId, gameTime } = params;

    const a = participants.find((p) => p.profile.id === initiatorId)!;
    const b = participants.find((p) => p.profile.id !== initiatorId)!;
    const timeString = tickToSceneTimeWithPeriod(gameTime.tick);

    const content = this.build("dialogue-finalize", {
      nameA: a.profile.name,
      idA: a.profile.id,
      familiarityAB: String(Math.round(a.relationship.familiarity)),
      affectionAB: String(Math.round(a.relationship.affection)),
      trustAB: String(Math.round(a.relationship.trust)),
      tensionAB: String(Math.round(a.relationship.tension)),
      nameB: b.profile.name,
      idB: b.profile.id,
      familiarityBA: String(Math.round(b.relationship.familiarity)),
      affectionBA: String(Math.round(b.relationship.affection)),
      trustBA: String(Math.round(b.relationship.trust)),
      tensionBA: String(Math.round(b.relationship.tension)),
      location,
      day: String(gameTime.day),
      timeString,
      motivation: params.initiatorMotivation,
      transcript: formatTranscript(params.transcript),
      endReason: params.endReason || "自然结束",
    });

    return [{ role: "user", content }];
  }

  buildDiaryMessages(params: {
    profile: CharacterProfile;
    todayMemories: string;
    gameDay: number;
  }): Message[] {
    const { profile, gameDay } = params;

    const content = this.build("diary", {
      name: profile.name,
      mbtiType: profile.mbtiType,
      coreTraits: profile.coreTraits.join("、"),
      speakingStyle: profile.speakingStyle,
      day: String(gameDay),
      todayMemories: params.todayMemories || "（今天没什么特别的事）",
    });

    return [{ role: "user", content }];
  }

  buildMemoryEvalMessages(params: {
    memories: { id: string; content: string }[];
  }): Message[] {
    const memoryList = params.memories
      .map((m) => `- [${m.id}] ${m.content}`)
      .join("\n");

    const content = this.build("memory-eval", {
      memoryList,
    });

    return [{ role: "user", content }];
  }

  buildSandboxChatMessages(params: {
    profile: CharacterProfile;
    state: CharacterState;
    memoriesBlock: string;
    userIdentity: string;
    transcript: { role: "user" | "character"; content: string }[];
    latestUserMessage: string;
  }): Message[] {
    const { profile, state } = params;

    const emotionLabel = getEmotionLabelSimple(
      state.emotionValence,
      state.emotionArousal,
    );

    const transcriptText =
      params.transcript.length === 0
        ? "（对话刚刚开始）"
        : params.transcript
            .map((t) => {
              const speaker = t.role === "user" ? "【对方】" : `【${profile.name}】`;
              return `${speaker} ${t.content}`;
            })
            .join("\n");

    const userIdentityBlock =
      params.userIdentity.trim().length > 0
        ? params.userIdentity.trim()
        : "对方没有给出具体身份——把 ta 当作一个忽然出现、你不太清楚底细的陌生对话者。";

    const content = this.build("sandbox-chat", {
      name: profile.name,
      mbtiType: profile.mbtiType,
      coreTraits: profile.coreTraits.join("、"),
      speakingStyle: profile.speakingStyle,
      coreMotivation: profile.coreMotivation,
      emotionLabel,
      memoriesBlock: params.memoriesBlock || "（没什么特别相关的记忆浮上来）",
      iconicCuesBlock: formatIconicCuesBlock(profile),
      userIdentityBlock,
      transcript: transcriptText,
      latestUserMessage: params.latestUserMessage,
    });

    return [{ role: "user", content }];
  }

  buildMicroReflectionMessages(params: {
    profile: CharacterProfile;
    gameDay: number;
    timeString?: string;
    currentFocus?: string;
    recentMemories: string;
  }): Message[] {
    const { profile, gameDay } = params;

    const content = this.build("micro-reflection", {
      name: profile.name,
      mbtiType: profile.mbtiType,
      coreTraits: profile.coreTraits.join("、"),
      day: String(gameDay),
      timeString: params.timeString || "此刻",
      currentFocus: params.currentFocus || "（此刻没有特别明确的牵挂）",
      recentMemories: params.recentMemories || "（这段时间没什么值得多想的）",
    });

    return [{ role: "user", content }];
  }

  buildReflectionMessages(params: {
    profile: CharacterProfile;
    gameDay: number;
    recentMemories: string;
    relationshipSummary: string;
  }): Message[] {
    const { profile, gameDay } = params;

    const content = this.build("reflection", {
      name: profile.name,
      mbtiType: profile.mbtiType,
      coreTraits: profile.coreTraits.join("、"),
      day: String(gameDay),
      recentMemories: params.recentMemories || "（今天没什么特别的事）",
      relationshipSummary: params.relationshipSummary || "（还没认识其他人）",
    });

    return [{ role: "user", content }];
  }
}

function getEmotionLabelSimple(valence: number, arousal: number): string {
  if (arousal > 6) {
    if (valence > 1) return "兴奋";
    if (valence < -1) return "愤怒";
    return "紧张";
  }
  if (arousal > 3) {
    if (valence > 1) return "满足";
    if (valence < -1) return "沮丧";
    return "平静";
  }
  if (valence > 1) return "安宁";
  if (valence < -1) return "悲伤";
  return "无聊";
}

function formatPerception(p: Perception): string {
  const lines: string[] = [];
  lines.push(`位置：${p.currentLocation}（${p.locationDescription}）`);

  if (p.objectsHere.length > 0) {
    lines.push("可见物件：");
    for (const obj of p.objectsHere) {
      const interactions =
        obj.availableInteractions.length > 0
          ? `（可：${obj.availableInteractions.join("、")}）`
          : "";
      lines.push(
        `  - ${obj.name}（${obj.state}）${obj.stateDescription ? " " + obj.stateDescription : ""}${interactions}`,
      );
    }
  }

  if (p.charactersHere.length > 0) {
    lines.push("能看到的人：");
    for (const c of p.charactersHere) {
      const locationHint =
        c.locationName && c.locationName !== p.currentLocation
          ? `（在${c.locationName}）`
          : "";
      const emotionHint = c.emotionLabel ? `（看起来${c.emotionLabel}）` : "";
      lines.push(
        `  - ${c.name}${locationHint}${c.currentAction ? "正在" + c.currentAction : ""}${emotionHint}`,
      );
    }
  }

  if (p.recentEnvironmentChanges.length > 0) {
    lines.push("最近变化：" + p.recentEnvironmentChanges.join("；"));
  }

  if (p.recentActions && p.recentActions.length > 0) {
    lines.push("你最近做过的事：" + p.recentActions.join("→"));
  }

  return lines.join("\n");
}

function formatTranscript(turns: { speaker: string; content: string }[]): string {
  if (turns.length === 0) return "（对话尚未开始）";
  return turns.map((turn) => `- ${turn.speaker}: ${turn.content}`).join("\n");
}

function formatIconicCuesBlock(profile: CharacterProfile): string {
  return buildIconicCuesText(profile) || "（无）";
}

function formatIconicCuesBlockForPair(
  a: CharacterProfile,
  b: CharacterProfile,
): string {
  const textA = buildIconicCuesText(a);
  const textB = buildIconicCuesText(b);
  if (!textA && !textB) return "（无）";
  const sections: string[] = [];
  if (textA) sections.push(`### ${a.name}\n${textA}`);
  if (textB) sections.push(`### ${b.name}\n${textB}`);
  return sections.join("\n\n");
}

function buildIconicCuesText(profile: CharacterProfile): string {
  const lines: string[] = [];
  const cues = profile.iconicCues;
  const refs = profile.canonicalRefs;

  if (cues) {
    if (cues.speechQuirks && cues.speechQuirks.length > 0) {
      lines.push(`- 说话习惯：${cues.speechQuirks.join("；")}`);
    }
    if (cues.catchphrases && cues.catchphrases.length > 0) {
      lines.push(`- 口头禅（最多 2 个，不要每次都说）：${cues.catchphrases.join(" / ")}`);
    }
    if (cues.behavioralTics && cues.behavioralTics.length > 0) {
      lines.push(`- 小动作：${cues.behavioralTics.join("；")}`);
    }
  }

  if (refs) {
    if (refs.source) {
      lines.push(`- 原型来源：${refs.source}`);
    }
    if (refs.keyRelationships && refs.keyRelationships.length > 0) {
      lines.push(`- 过去真正在意的人：${refs.keyRelationships.join("；")}`);
    }
    if (refs.signatureMoments && refs.signatureMoments.length > 0) {
      lines.push(
        `- 标志性经历（藏起来的"软肋/执念"，别主动炫耀，只在情境触发时才轻轻流露）：${refs.signatureMoments.join("；")}`,
      );
    }
  }

  return lines.join("\n");
}

export const promptBuilder = new PromptBuilder();
