import type { RelationshipLabel, GameTime } from "../types/index.js";
import type { CharacterManager } from "../core/character-manager.js";

export interface RelationshipGraphData {
  nodes: {
    id: string;
    name: string;
    mbti: string;
    emotion: string;
  }[];
  edges: {
    source: string;
    target: string;
    label: RelationshipLabel;
    strength: number;
    color: string;
  }[];
  generatedAt: GameTime;
}

const LABEL_COLORS: Record<string, string> = {
  lover: "#ff6b6b",
  crush: "#ff6b6b",
  friend: "#4ecdc4",
  close_friend: "#4ecdc4",
  rival: "#ff9f43",
  frenemy: "#feca57",
};
const DEFAULT_EDGE_COLOR = "#95a5a6";

const FAMILIARITY_THRESHOLD = 15;

export function generateGraphSnapshot(
  characterManager: CharacterManager,
): RelationshipGraphData {
  const profiles = characterManager.getAllProfiles();
  const gameTime = { day: 0, tick: 0 }; // caller can override via return value

  const nodes = profiles.map((p) => {
    const state = characterManager.getState(p.id);
    return {
      id: p.id,
      name: p.name,
      mbti: p.mbtiType,
      emotion: `${state.emotionValence.toFixed(1)}/${state.emotionArousal.toFixed(1)}`,
    };
  });

  const edges: RelationshipGraphData["edges"] = [];
  const seen = new Set<string>();

  for (const p of profiles) {
    const rels = characterManager.relationshipManager.getAllRelationshipsOf(p.id);
    for (const rel of rels) {
      if (rel.familiarity < FAMILIARITY_THRESHOLD) continue;

      const pairKey = [rel.characterId, rel.targetId].sort().join(":");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const label = characterManager.relationshipManager.deriveLabel(rel);
      const strength = (rel.familiarity + rel.affection + rel.trust) / 3;
      const color = LABEL_COLORS[label] ?? DEFAULT_EDGE_COLOR;

      edges.push({
        source: rel.characterId,
        target: rel.targetId,
        label,
        strength: Math.round(strength * 10) / 10,
        color,
      });
    }
  }

  return { nodes, edges, generatedAt: gameTime };
}
