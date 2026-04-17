import { getDb } from "./db.js";
import type { Relationship } from "../types/index.js";

function rowToRelationship(row: any): Relationship {
  return {
    characterId: row.character_id,
    targetId: row.target_id,
    familiarity: row.familiarity,
    trust: row.trust,
    affection: row.affection,
    respect: row.respect,
    tension: row.tension,
    romanticFlag: row.romantic_flag === 1,
  };
}

export function initRelationship(rel: Relationship): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO relationships
       (character_id, target_id, familiarity, trust, affection, respect, tension, romantic_flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rel.characterId,
      rel.targetId,
      rel.familiarity,
      rel.trust,
      rel.affection,
      rel.respect,
      rel.tension,
      rel.romanticFlag ? 1 : 0,
    );
}

export function getRelationship(charId: string, targetId: string): Relationship | null {
  const row = getDb()
    .prepare("SELECT * FROM relationships WHERE character_id = ? AND target_id = ?")
    .get(charId, targetId) as any;
  return row ? rowToRelationship(row) : null;
}

export function getRelationshipsOf(charId: string): Relationship[] {
  return (
    getDb()
      .prepare("SELECT * FROM relationships WHERE character_id = ?")
      .all(charId) as any[]
  ).map(rowToRelationship);
}

export function getAllRelationships(): Relationship[] {
  return (getDb().prepare("SELECT * FROM relationships").all() as any[]).map(rowToRelationship);
}

export function updateRelationship(
  charId: string,
  targetId: string,
  patch: Partial<Relationship>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.familiarity !== undefined) {
    sets.push("familiarity = ?");
    params.push(patch.familiarity);
  }
  if (patch.trust !== undefined) {
    sets.push("trust = ?");
    params.push(patch.trust);
  }
  if (patch.affection !== undefined) {
    sets.push("affection = ?");
    params.push(patch.affection);
  }
  if (patch.respect !== undefined) {
    sets.push("respect = ?");
    params.push(patch.respect);
  }
  if (patch.tension !== undefined) {
    sets.push("tension = ?");
    params.push(patch.tension);
  }
  if (patch.romanticFlag !== undefined) {
    sets.push("romantic_flag = ?");
    params.push(patch.romanticFlag ? 1 : 0);
  }

  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  params.push(charId, targetId);

  getDb()
    .prepare(
      `UPDATE relationships SET ${sets.join(", ")} WHERE character_id = ? AND target_id = ?`,
    )
    .run(...params);
}

export function batchUpdateRelationships(
  updates: { charId: string; targetId: string; patch: Partial<Relationship> }[],
): void {
  const db = getDb();
  db.transaction(() => {
    for (const u of updates) {
      updateRelationship(u.charId, u.targetId, u.patch);
    }
  })();
}
