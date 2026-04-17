import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATED_WORLDS_DIR = path.resolve(__dirname, "../../../output/worlds");

export interface GeneratedWorldSummary {
  id: string;
  worldName: string;
  dir: string;
}

export function resolveInitialWorldDir(): string | undefined {
  const fromEnv = process.env.WORLD_DIR;
  if (fromEnv && isDirectory(fromEnv)) {
    return path.resolve(fromEnv);
  }

  return listGeneratedWorlds()[0]?.dir;
}

export function listGeneratedWorlds(): GeneratedWorldSummary[] {
  if (!isDirectory(GENERATED_WORLDS_DIR)) {
    return [];
  }

  return fs.readdirSync(GENERATED_WORLDS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(GENERATED_WORLDS_DIR, entry.name);
      return {
        id: entry.name,
        worldName: readWorldName(dir) ?? entry.name,
        dir,
      };
    })
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
      console.warn(`[WorldSeed] Failed to read world metadata from ${filePath}:`, error);
    }
  }

  return null;
}

function isDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}
