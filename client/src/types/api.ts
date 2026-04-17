export interface GameTime {
  day: number;
  tick: number;
}

export interface MultiDayConfig {
  enabled: boolean;
  dayTransitionText: string;
  nextDayStartTime: string;
}

export interface SceneConfigInfo {
  sceneType: string;
  startTime: string;
  tickDurationMinutes: number;
  maxTicks: number | null;
  displayFormat: string;
  description: string;
  multiDay: MultiDayConfig;
}

export interface SceneRuntimeInfo {
  bounded: boolean;
  cycleTicks: number;
  naturalDayTicks: number;
  transitionEnabled: boolean;
}

export interface CharacterInfo {
  id: string;
  name: string;
  mbti: string;
  nickname: string;
  location: string;
  mainAreaPointId?: string | null;
  emotion: string;
  currentAction: string | null;
  currentActionLabel?: string | null;
  anchor?: { type: "region" | "element"; targetId: string } | null;
}

export interface CharacterProfile {
  id: string;
  name: string;
  mbtiType: string;
  nickname: string;
  backstory?: string;
  coreTraits: string[];
  coreMotivation: string;
  coreValues: string[];
  speakingStyle: string;
  fears: string[];
  socialStyle: string;
  tags: string[];
  [key: string]: unknown;
}

export interface CharacterDetail {
  profile: CharacterProfile;
  state: {
    location: string;
    mainAreaPointId?: string | null;
    currentAction: string | null;
    currentActionLabel?: string | null;
    emotionValence: number;
    emotionArousal: number;
    curiosity: number;
  };
  emotionLabel: string;
}

export interface RelationshipDimensions {
  familiarity: number;
  trust: number;
  affection: number;
  respect: number;
  tension: number;
  romanticFlag: boolean;
}

export interface RelationshipEdge {
  targetId: string;
  targetName: string;
  label: string;
  dimensions: RelationshipDimensions;
}

export interface DiaryEntry {
  day: number;
  content: string;
  createdAt: string;
}

export interface MemoryEntry {
  type: string;
  content: string;
  importance: number;
  createdAt: string;
}

export interface DialogueTurn {
  speaker: string;
  content: string;
  innerMonologue?: string;
}

export interface DialogueEventData {
  conversationId: string;
  phase: "turn" | "complete";
  turns: DialogueTurn[];
  turnIndexStart: number;
  isFinal: boolean;
  participants: string[];
  memoriesGenerated?: Record<string, string>;
  relationshipDeltas?: Record<string, Record<string, number>>;
  endReason?: string;
}

export interface SimulationEvent {
  id: string;
  type: string;
  gameDay: number;
  gameTick: number;
  timeString?: string;
  period?: string;
  actorId?: string;
  targetId?: string;
  location?: string;
  data: any | DialogueEventData;
  innerMonologue?: string;
  dramScore?: number;
  createdAt: string;
}

export interface WorldTimeInfo extends GameTime {
  timeString: string;
  period: string;
}

export interface LocationInfo {
  id: string;
  name: string;
  description: string;
}

export interface MainAreaPointInfo {
  id: string;
  name: string;
  x: number;
  y: number;
  adjacentPointIds: string[];
}

export interface GraphData {
  nodes: { id: string; name: string; mbti: string }[];
  edges: { source: string; target: string; label: string; strength: number }[];
  generatedAt?: GameTime | string;
}
