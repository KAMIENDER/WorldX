import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const GENERATED_WORLDS_DIR = path.resolve(__dirname, "../../../output/worlds");
export const LIBRARY_WORLDS_DIR = path.resolve(__dirname, "../../../library/worlds");
const DEFAULT_LIBRARY_WORLD_ID = "world_2026-04-19T08-31-24";

export type WorldSource = "user" | "library";

export interface GeneratedWorldSummary {
  id: string;
  worldName: string;
  dir: string;
  source: WorldSource;
}

export function resolveInitialWorldDir(): string | undefined {
  const fromEnv = process.env.WORLD_DIR;
  if (fromEnv && isDirectory(fromEnv)) {
    return path.resolve(fromEnv);
  }

  const userWorlds = listGeneratedWorlds();
  if (userWorlds.length > 0) {
    return userWorlds[0].dir;
  }

  const libraryWorlds = listLibraryWorlds();
  return libraryWorlds.find((world) => world.id === DEFAULT_LIBRARY_WORLD_ID)?.dir ?? libraryWorlds[0]?.dir;
}

export function listGeneratedWorlds(): GeneratedWorldSummary[] {
  return scanWorldsDir(GENERATED_WORLDS_DIR, "user");
}

export function listLibraryWorlds(): GeneratedWorldSummary[] {
  return scanWorldsDir(LIBRARY_WORLDS_DIR, "library");
}

export function listAllWorlds(): GeneratedWorldSummary[] {
  const userWorlds = listGeneratedWorlds();
  const libWorlds = listLibraryWorlds();
  return [...userWorlds, ...libWorlds];
}

export function findWorldById(worldId: string): GeneratedWorldSummary | undefined {
  return listAllWorlds().find((w) => w.id === worldId);
}

function scanWorldsDir(baseDir: string, source: WorldSource): GeneratedWorldSummary[] {
  if (!isDirectory(baseDir)) {
    return [];
  }

  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(baseDir, entry.name);
      return {
        id: entry.name,
        worldName: readWorldName(dir),
        dir,
        source,
      };
    })
    .filter((entry): entry is GeneratedWorldSummary & { worldName: string } =>
      entry.worldName !== null && hasWorldConfig(entry.dir),
    )
    .sort((a, b) => b.id.localeCompare(a.id));
}

function readWorldName(worldDir: string): string | null {
  const candidates = [
    path.join(worldDir, "world.json"),
    path.join(worldDir, "config", "world.json"),
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as { worldName?: unknown };
      if (typeof parsed.worldName === "string" && parsed.worldName.trim()) {
        return parsed.worldName.trim();
      }
    } catch (error) {
      console.warn(`[WorldX] Failed to read world metadata from ${filePath}:`, error);
    }
  }

  return null;
}

function hasWorldConfig(worldDir: string): boolean {
  return (
    fs.existsSync(path.join(worldDir, "world.json")) ||
    fs.existsSync(path.join(worldDir, "config", "world.json"))
  );
}

function isDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}
