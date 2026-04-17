import type { CharacterInfo, LocationInfo, SimulationEvent } from "../../types/api";

const EVENT_TYPE_LABELS: Record<string, string> = {
  dialogue: "对话",
  movement: "移动",
  action_start: "开始行动",
  action_end: "结束行动",
  event_triggered: "事件触发",
  emotion_shift: "状态变化",
  reflection: "反思",
  memory_formed: "形成记忆",
};

const ACTION_LABELS: Record<string, string> = {
  sleep: "睡觉",
  cook: "做饭",
  eat: "吃饭",
  read: "阅读",
  read_bulletin: "看公告",
  write_diary: "写日记",
  talk: "聊天",
  in_conversation: "对话中",
  traveling: "移动中",
  idle: "发呆",
  fish: "钓鱼",
  explore: "探索",
  repair: "修理",
  think_in_bed: "躺床上思考",
  lock_door: "锁门",
  unlock_door: "开锁",
  people_watch: "闲坐观望",
  use_computer: "使用电脑",
  have_drink: "喝饮料",
  craft: "做手工",
  stroll: "散步",
  tend_garden: "打理花园",
  post_message: "张贴留言",
  move_within_main_area: "在主区域换位置",
};

type EventFormatContext = {
  characterNames?: Record<string, string>;
  locationNames?: Record<string, string>;
};

export function buildCharacterNameMap(characters: CharacterInfo[]): Record<string, string> {
  return Object.fromEntries(characters.map((character) => [character.id, character.name]));
}

export function buildLocationNameMap(locations: LocationInfo[]): Record<string, string> {
  return Object.fromEntries(locations.map((location) => [location.id, location.name]));
}

export function formatEventType(type: string): string {
  return EVENT_TYPE_LABELS[type] || prettifyToken(type);
}

export function formatEventSummary(
  event: SimulationEvent,
  context: EventFormatContext = {},
): string {
  const actorName = formatCharacterName(event.actorId, context.characterNames);
  const targetName = formatCharacterName(event.targetId, context.characterNames);
  const currentLocation = formatLocationName(event.location, context.locationNames);
  const actionName = formatActionName(
    event.data?.actionName ?? event.data?.interactionName ?? event.data?.action ?? event.data?.interactionId ?? event.data?.actionType,
  );

  switch (event.type) {
    case "movement": {
      if (event.data?.actionType === "move_within_main_area") {
        return actorName ? `${actorName} 在主区域换了个地方活动` : "在主区域换了个地方活动";
      }
      const destination = formatLocationName(
        event.data?.to ?? event.data?.toLocation ?? event.location,
        context.locationNames,
      );
      return actorName ? `${actorName} 前往 ${destination}` : `前往 ${destination}`;
    }
    case "action_start":
      if (actorName && currentLocation !== "某处") {
        return `${actorName} 在${currentLocation}开始${actionName}`;
      }
      return actorName ? `${actorName} 开始${actionName}` : `开始${actionName}`;
    case "action_end":
      return actorName ? `${actorName} 结束${actionName}` : `结束${actionName}`;
    case "dialogue": {
      const phase = event.data?.phase;
      const turnCount = event.data?.turns?.length || 0;
      if (phase === "turn") {
        const preview = event.data?.turns?.[0]?.content;
        if (actorName && targetName && preview) {
          return `${actorName} 对 ${targetName} 说：“${preview}”`;
        }
        return actorName ? `${actorName} 说了一句` : "出现了一句对话";
      }
      if (actorName && targetName) {
        return `${actorName} 与 ${targetName} 对话结束（${turnCount}句）`;
      }
      return actorName
        ? `${actorName} 完成一段对话（${turnCount}句）`
        : `发生对话（${turnCount}句）`;
    }
    case "emotion_shift": {
      const needName = formatNeedName(event.data?.urgentNeed);
      const value =
        typeof event.data?.value === "number" ? Math.round(event.data.value) : null;
      if (actorName) {
        return value == null
          ? `${actorName} 的${needName}变得紧迫`
          : `${actorName} 的${needName}变得紧迫（${value}/100）`;
      }
      return `${needName}变得紧迫`;
    }
    case "reflection":
      return actorName ? `${actorName} 进行了一次反思` : "有人进行了一次反思";
    case "memory_formed":
      return actorName ? `${actorName} 记下了一件事` : "有人形成了一段记忆";
    case "event_triggered":
      return event.data?.title || event.data?.name || event.data?.summary || "触发了一条剧情事件";
    default:
      if (actorName) return `${actorName}：${summarizePayload(event.data)}`;
      return summarizePayload(event.data);
  }
}

function formatCharacterName(
  characterId: string | undefined,
  nameMap: Record<string, string> | undefined,
): string {
  if (!characterId) return "";
  return nameMap?.[characterId] || prettifyToken(characterId.replace(/^char_/, ""));
}

function formatLocationName(
  locationId: string | undefined,
  nameMap: Record<string, string> | undefined,
): string {
  if (!locationId) return "某处";
  return nameMap?.[locationId] || prettifyToken(locationId);
}

export function formatActionName(action: string | undefined): string {
  if (!action) return "行动";
  return ACTION_LABELS[action] || prettifyToken(action);
}

function summarizePayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "发生了一件事";
  const namedPayload = payload as Record<string, unknown>;
  if (typeof namedPayload.summary === "string") return namedPayload.summary;
  if (typeof namedPayload.actionName === "string") return namedPayload.actionName;
  if (typeof namedPayload.interactionName === "string") return namedPayload.interactionName;
  if (typeof namedPayload.action === "string") return formatActionName(namedPayload.action);
  if (typeof namedPayload.interactionId === "string") return formatActionName(namedPayload.interactionId);
  if (typeof namedPayload.toLocation === "string") return `前往 ${prettifyToken(namedPayload.toLocation)}`;
  if (typeof namedPayload.to === "string") return `前往 ${prettifyToken(namedPayload.to)}`;
  return "发生了一件事";
}

function prettifyToken(token: string): string {
  return token
    .replace(/^char_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatNeedName(need: unknown): string {
  switch (need) {
    case "curiosity":
      return "好奇心";
    default:
      return typeof need === "string" ? prettifyToken(need) : "某项状态";
  }
}
