import { getDb } from "./db.js";
import type { CharacterRelationship } from "../types/index.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function rowToRelationship(row: any): CharacterRelationship {
  return {
    sourceCharacterId: row.source_character_id,
    targetCharacterId: row.target_character_id,
    familiarity: row.familiarity ?? 0,
    affinity: row.affinity ?? 0,
    trust: row.trust ?? 0,
    fear: row.fear ?? 0,
    conflict: row.conflict ?? 0,
    debt: row.debt ?? 0,
    notes: row.notes ?? "",
  };
}

export function initRelationship(relationship: CharacterRelationship): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO character_relationships
       (source_character_id, target_character_id, familiarity, affinity, trust, fear, conflict, debt, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      relationship.sourceCharacterId,
      relationship.targetCharacterId,
      clamp(relationship.familiarity, 0, 100),
      clamp(relationship.affinity, -100, 100),
      clamp(relationship.trust, -100, 100),
      clamp(relationship.fear, 0, 100),
      clamp(relationship.conflict, 0, 100),
      clamp(relationship.debt, -100, 100),
      relationship.notes,
    );
}

export function getRelationship(
  sourceCharacterId: string,
  targetCharacterId: string,
): CharacterRelationship | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM character_relationships
       WHERE source_character_id = ? AND target_character_id = ?`,
    )
    .get(sourceCharacterId, targetCharacterId) as any;
  return row ? rowToRelationship(row) : null;
}

export function getRelationshipsFor(sourceCharacterId: string): CharacterRelationship[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM character_relationships
         WHERE source_character_id = ?
         ORDER BY familiarity DESC, ABS(affinity) DESC, target_character_id`,
      )
      .all(sourceCharacterId) as any[]
  ).map(rowToRelationship);
}

export function updateRelationship(
  sourceCharacterId: string,
  targetCharacterId: string,
  patch: Partial<Omit<CharacterRelationship, "sourceCharacterId" | "targetCharacterId">>,
): void {
  initRelationship({
    sourceCharacterId,
    targetCharacterId,
    familiarity: 0,
    affinity: 0,
    trust: 0,
    fear: 0,
    conflict: 0,
    debt: 0,
    notes: "",
  });

  const current = getRelationship(sourceCharacterId, targetCharacterId);
  if (!current) return;

  const next = {
    familiarity: patch.familiarity ?? current.familiarity,
    affinity: patch.affinity ?? current.affinity,
    trust: patch.trust ?? current.trust,
    fear: patch.fear ?? current.fear,
    conflict: patch.conflict ?? current.conflict,
    debt: patch.debt ?? current.debt,
    notes: patch.notes ?? current.notes,
  };

  getDb()
    .prepare(
      `UPDATE character_relationships
       SET familiarity = ?, affinity = ?, trust = ?, fear = ?, conflict = ?, debt = ?, notes = ?, updated_at = datetime('now')
       WHERE source_character_id = ? AND target_character_id = ?`,
    )
    .run(
      clamp(next.familiarity, 0, 100),
      clamp(next.affinity, -100, 100),
      clamp(next.trust, -100, 100),
      clamp(next.fear, 0, 100),
      clamp(next.conflict, 0, 100),
      clamp(next.debt, -100, 100),
      next.notes,
      sourceCharacterId,
      targetCharacterId,
    );
}

export function adjustRelationship(
  sourceCharacterId: string,
  targetCharacterId: string,
  delta: Partial<Record<"familiarity" | "affinity" | "trust" | "fear" | "conflict" | "debt", number>>,
  note?: string,
): void {
  const current =
    getRelationship(sourceCharacterId, targetCharacterId) ?? {
      sourceCharacterId,
      targetCharacterId,
      familiarity: 0,
      affinity: 0,
      trust: 0,
      fear: 0,
      conflict: 0,
      debt: 0,
      notes: "",
    };
  updateRelationship(sourceCharacterId, targetCharacterId, {
    familiarity: current.familiarity + (delta.familiarity ?? 0),
    affinity: current.affinity + (delta.affinity ?? 0),
    trust: current.trust + (delta.trust ?? 0),
    fear: current.fear + (delta.fear ?? 0),
    conflict: current.conflict + (delta.conflict ?? 0),
    debt: current.debt + (delta.debt ?? 0),
    notes: note ?? current.notes,
  });
}
