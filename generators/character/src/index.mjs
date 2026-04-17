/**
 * Character Generator Pipeline
 *
 * Usage:
 *   node src/index.mjs "角色描述文字"
 *   node src/index.mjs "现代女性，橙色连帽衫，蓝色牛仔裤，黄色长发"
 *   node src/index.mjs "中世纪骑士，银色盔甲，红色披风，短发" --name "Knight"
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { editImage } from "./models/gemini-flash-img.mjs";
import { removeGreenBackground } from "./utils/chromakey.mjs";
import { buildMetadata } from "./utils/sprite-meta.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");
const WORLD_SEED_ROOT = resolve(PROJECT_ROOT, "../..");

dotenv.config({ path: resolve(WORLD_SEED_ROOT, ".env") });

const CHARACTERS_DIR = process.env.CHAR_OUTPUT_DIR || resolve(WORLD_SEED_ROOT, "output/characters");
const CHARACTERS_JSON = join(CHARACTERS_DIR, "characters.json");

installPhaseStepLogPrefix("Phase 3");

async function main() {
  const args = process.argv.slice(2);
  const nameIdx = args.indexOf("--name");
  let charName = null;
  if (nameIdx !== -1) {
    charName = args[nameIdx + 1];
    args.splice(nameIdx, 2);
  }

  const description = args.join(" ").trim();
  if (!description) {
    console.error("Usage: node src/index.mjs \"角色描述\" [--name CharName]");
    process.exit(1);
  }

  const charId = `char_${Date.now()}`;
  charName = charName || description.slice(0, 20);

  console.log(`\n=== Character Generator ===`);
  console.log(`ID:          ${charId}`);
  console.log(`Name:        ${charName}`);
  console.log(`Description: ${description}`);
  console.log();

  const outputDir = join(CHARACTERS_DIR, charId);
  mkdirSync(outputDir, { recursive: true });

  // ── Step 1: Generate sprite sheet ─────────────────────────────

  console.log("[Step 1] Generating sprite sheet...");

  const referenceImg = readFileSync(join(PROJECT_ROOT, "reference-img.png"));
  const promptTemplate = readFileSync(
    join(PROJECT_ROOT, "prompts/generate-sprite.md"),
    "utf-8",
  );

  const promptText = promptTemplate.replace(
    /\{\{characterDescription\}\}/g,
    description,
  );

  let spriteBuffer;
  try {
    spriteBuffer = await editImage(promptText, referenceImg, {
      imageSize: "1K",
    });
  } catch (err) {
    console.error(`[Step 1] Generation failed: ${err.message}`);
    process.exit(1);
  }

  const rawPath = join(outputDir, "spritesheet-raw.png");
  writeFileSync(rawPath, spriteBuffer);
  console.log(`[Step 1] Saved raw sprite sheet: ${rawPath}`);

  // ── Step 2: Chromakey ─────────────────────────────────────────

  console.log("[Step 2] Removing green background...");
  const transparentBuffer = await removeGreenBackground(spriteBuffer);
  const spritePath = join(outputDir, "spritesheet.png");
  writeFileSync(spritePath, transparentBuffer);
  console.log(`[Step 2] Saved transparent sprite sheet: ${spritePath}`);

  // ── Step 3: Metadata ──────────────────────────────────────────

  console.log("[Step 3] Generating metadata...");
  const metadata = await buildMetadata(transparentBuffer, {
    id: charId,
    name: charName,
    description,
  });
  const metaPath = join(outputDir, "metadata.json");
  writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
  console.log(`[Step 3] Saved metadata: ${metaPath}`);

  // ── Step 4: Update characters.json ────────────────────────────

  console.log("[Step 4] Updating characters.json...");
  let characters = [];
  if (existsSync(CHARACTERS_JSON)) {
    try {
      characters = JSON.parse(readFileSync(CHARACTERS_JSON, "utf-8"));
    } catch {
      characters = [];
    }
  }

  characters.push({
    id: charId,
    name: charName,
    description,
    createdAt: metadata.createdAt,
  });

  writeFileSync(CHARACTERS_JSON, JSON.stringify(characters, null, 2));
  console.log(`[Step 4] Updated: ${CHARACTERS_JSON}`);

  console.log(`\n=== Done! Character "${charName}" generated. ===`);
  console.log(`Output: ${outputDir}`);
}

main().catch((err) => {
  console.error("Pipeline error:", err);
  process.exit(1);
});

function installPhaseStepLogPrefix(phaseLabel) {
  for (const method of ["log", "warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args.map((arg) => prefixPhaseStep(arg, phaseLabel)));
    };
  }
}

function prefixPhaseStep(value, phaseLabel) {
  if (typeof value !== "string") return value;
  return value
    .replace(/═══ Step /g, `═══ ${phaseLabel} · Step `)
    .replace(/\[Step /g, `[${phaseLabel} · Step `);
}
