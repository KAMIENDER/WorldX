import type { Relationship, RelationshipLabel, CharacterProfile } from "../types/index.js";
import * as relStore from "../store/relationship-store.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class RelationshipManager {
  private profiles: Map<string, CharacterProfile>;

  constructor(profiles: Map<string, CharacterProfile>) {
    this.profiles = profiles;
  }

  initRelationshipPair(charA: string, charB: string): void {
    const relAB: Relationship = {
      characterId: charA,
      targetId: charB,
      familiarity: 0,
      trust: 0,
      affection: 0,
      respect: 0,
      tension: 0,
      romanticFlag: false,
    };
    const relBA: Relationship = {
      characterId: charB,
      targetId: charA,
      familiarity: 0,
      trust: 0,
      affection: 0,
      respect: 0,
      tension: 0,
      romanticFlag: false,
    };
    relStore.initRelationship(relAB);
    relStore.initRelationship(relBA);
  }

  getRelationship(charId: string, targetId: string): Relationship | null {
    return relStore.getRelationship(charId, targetId);
  }

  getAllRelationshipsOf(charId: string): Relationship[] {
    return relStore.getRelationshipsOf(charId);
  }

  updateRelationship(
    charId: string,
    targetId: string,
    deltas: {
      familiarity?: number;
      trust?: number;
      affection?: number;
      respect?: number;
      tension?: number;
    },
  ): Relationship {
    const rel = relStore.getRelationship(charId, targetId);
    if (!rel) throw new Error(`Relationship not found: ${charId} → ${targetId}`);

    const updated: Partial<Relationship> = {};
    if (deltas.familiarity !== undefined) {
      updated.familiarity = clamp(rel.familiarity + deltas.familiarity, 0, 100);
    }
    if (deltas.trust !== undefined) {
      updated.trust = clamp(rel.trust + deltas.trust, 0, 100);
    }
    if (deltas.affection !== undefined) {
      updated.affection = clamp(rel.affection + deltas.affection, 0, 100);
    }
    if (deltas.respect !== undefined) {
      updated.respect = clamp(rel.respect + deltas.respect, 0, 100);
    }
    if (deltas.tension !== undefined) {
      updated.tension = clamp(rel.tension + deltas.tension, 0, 100);
    }

    relStore.updateRelationship(charId, targetId, updated);

    return { ...rel, ...updated };
  }

  deriveLabel(rel: Relationship): RelationshipLabel {
    if (rel.familiarity < 20) return "stranger";
    if (rel.familiarity < 40) return "acquaintance";

    if (rel.affection >= 80 && rel.romanticFlag) {
      const reverse = relStore.getRelationship(rel.targetId, rel.characterId);
      if (reverse && reverse.affection >= 80 && reverse.romanticFlag) {
        return "lover";
      }
      return "crush";
    }

    if (rel.tension >= 70 && rel.affection < 30) return "rival";
    if (rel.affection >= 40 && rel.tension >= 50) return "frenemy";

    if (
      rel.affection >= 70 &&
      rel.trust >= 70 &&
      rel.familiarity >= 70
    ) {
      return "close_friend";
    }
    if (
      rel.familiarity >= 50 &&
      rel.affection >= 50 &&
      rel.trust >= 40
    ) {
      return "friend";
    }

    return "acquaintance";
  }

  deriveAllLabels(): {
    characterId: string;
    targetId: string;
    label: RelationshipLabel;
  }[] {
    const all = relStore.getAllRelationships();
    return all.map((rel) => ({
      characterId: rel.characterId,
      targetId: rel.targetId,
      label: this.deriveLabel(rel),
    }));
  }

  getRelationshipSummaryForPrompt(charId: string): string {
    const rels = relStore
      .getRelationshipsOf(charId)
      .filter((r) => r.familiarity >= 15)
      .sort((a, b) => b.familiarity - a.familiarity);

    if (rels.length === 0) return "（尚无显著社交关系）";

    return rels
      .map((r) => {
        const profile = this.profiles.get(r.targetId);
        const name = profile ? `${profile.name}(${profile.mbtiType})` : r.targetId;

        const parts: string[] = [];

        if (r.familiarity >= 70) parts.push(`很熟(熟悉${Math.round(r.familiarity)})`);
        else if (r.familiarity >= 40) parts.push(`比较熟(熟悉${Math.round(r.familiarity)})`);
        else parts.push(`不太熟(熟悉${Math.round(r.familiarity)})`);

        if (r.affection >= 50) parts.push(`有好感(好感${Math.round(r.affection)})`);
        else if (r.affection >= 30) parts.push(`有些好感(好感${Math.round(r.affection)})`);

        if (r.trust >= 50) parts.push(`比较信任(信任${Math.round(r.trust)})`);
        else if (r.trust >= 30) parts.push(`信任一般(信任${Math.round(r.trust)})`);

        if (r.tension >= 50) parts.push(`关系紧张(紧张${Math.round(r.tension)})`);

        if (parts.length <= 1) parts.push("关系平淡");

        return `- ${name}: ${parts.join(", ")}`;
      })
      .join("\n");
  }
}
