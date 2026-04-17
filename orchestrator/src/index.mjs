import dotenv from "dotenv";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, rmSync } from "fs";
import { spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
dotenv.config({ path: join(ROOT, ".env") });

import { designWorld } from "./world-designer.mjs";
import { generateConfigs } from "./config-generator.mjs";

const MAP_GENERATION_TIMEOUT_MS = parseInt(process.env.MAP_GENERATION_TIMEOUT_MS || "900000", 10);
const CHARACTER_GENERATION_TIMEOUT_MS = parseInt(
  process.env.CHARACTER_GENERATION_TIMEOUT_MS || "300000",
  10,
);

async function main() {
  const userPrompt = process.argv.slice(2).join(" ");
  if (!userPrompt) {
    console.error('Usage: node orchestrator/src/index.mjs "描述你想创造的世界"');
    console.error(
      'Example: node orchestrator/src/index.mjs "宋朝繁华夜市，有算命先生、卖艺人、小偷、女侠、书生、酒鬼"'
    );
    process.exit(1);
  }

  const worldId = `world_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const worldDir = join(ROOT, "output/worlds", worldId);
  mkdirSync(worldDir, { recursive: true });

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║         WorldSeed: One Sentence, One World       ║");
  console.log("╚══════════════════════════════════════════════╝\n");
  console.log(`World ID: ${worldId}`);
  console.log(`Prompt:   ${userPrompt}\n`);

  console.log("━━━ Phase 1: Designing World ━━━");
  const worldDesign = await designWorld(userPrompt);
  writeFileSync(join(worldDir, "world-design.json"), JSON.stringify(worldDesign, null, 2));

  const mapDir = join(worldDir, "map");
  mkdirSync(mapDir, { recursive: true });
  const charsDir = join(worldDir, "characters");
  mkdirSync(charsDir, { recursive: true });
  const mapScript = join(ROOT, "generators/map/src/index.mjs");
  const charScript = join(ROOT, "generators/character/src/index.mjs");

  console.log("\n━━━ Phase 2 + Phase 3: Generating Map and Characters in Parallel ━━━");
  const [mapResult, characterResult] = await Promise.allSettled([
    generateMapAssets({
      mapDir,
      worldDir,
      mapScript,
      mapDescription: worldDesign.mapDescription,
    }),
    generateCharacterAssets({
      charsDir,
      charScript,
      characters: worldDesign.characters,
    }),
  ]);
  if (mapResult.status === "rejected") throw mapResult.reason;
  if (characterResult.status === "rejected") throw characterResult.reason;

  console.log("\n━━━ Phase 4: Generating Simulation Configs ━━━");
  const { worldConfig, characterConfigs, sceneConfig } = generateConfigs(worldDesign, worldDir);

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║              World Generation Complete!           ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`\n  World:      ${worldDesign.worldName}`);
  console.log(`  ID:         ${worldId}`);
  console.log(`  Characters: ${characterConfigs.length}`);
  console.log(`  Locations:  ${worldConfig.locations.length}`);
  console.log(`  Scene type: ${sceneConfig.sceneType}`);
  console.log(`  Output:     ${worldDir}`);
  console.log(`\n  To run:     WORLD_ID=${worldId} npm run dev`);
  console.log();
}

async function generateMapAssets({ mapDir, worldDir, mapScript, mapDescription }) {
  console.log("\n━━━ Phase 2: Generating Map ━━━");

  try {
    await runNodeScript(mapScript, [mapDescription], {
      env: {
        MAP_OUTPUT_DIR: mapDir,
        WORLD_DESIGN_PATH: join(worldDir, "world-design.json"),
      },
      timeoutMs: MAP_GENERATION_TIMEOUT_MS,
      label: "Map generation",
    });
  } catch (err) {
    console.error("Map generation failed:", err.message);
    flattenNestedOutputInto(mapDir);
    if (!existsSync(join(mapDir, "06-final.tmj"))) {
      throw new Error("Map generation failed and no TMJ output found");
    }
  }

  if (!existsSync(join(mapDir, "06-final.tmj"))) {
    flattenNestedOutputInto(mapDir);
  }

  if (!existsSync(join(mapDir, "06-final.tmj"))) {
    throw new Error("Map generation completed without a TMJ output");
  }
}

async function generateCharacterAssets({ charsDir, charScript, characters }) {
  console.log("\n━━━ Phase 3: Generating Characters ━━━");

  for (let i = 0; i < characters.length; i++) {
    const char = characters[i];
    console.log(`\nGenerating character ${i + 1}/${characters.length}: ${char.name}`);

    try {
      await runNodeScript(charScript, [char.appearance, "--name", char.name], {
        env: {
          CHAR_OUTPUT_DIR: charsDir,
        },
        timeoutMs: CHARACTER_GENERATION_TIMEOUT_MS,
        label: `Character "${char.name}" generation`,
      });
    } catch (err) {
      console.error(`Character "${char.name}" generation failed: ${err.message}`);
      console.error("Continuing with remaining characters...");
    }
  }
}

function runNodeScript(scriptPath, args, { env = {}, timeoutMs = 0, label = "Process" } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timeoutHandle = null;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (error) rejectPromise(error);
      else resolvePromise();
    };

    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...env,
      },
      stdio: "inherit",
    });

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        child.kill("SIGTERM");
        const forceKillHandle = setTimeout(() => child.kill("SIGKILL"), 5000);
        forceKillHandle.unref?.();
        finish(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeoutHandle.unref?.();
    }

    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          `${label} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
}

function flattenNestedOutputInto(parentDir) {
  const entries = readdirSync(parentDir).filter((entry) => !entry.startsWith("."));

  for (const entry of entries) {
    const entryPath = join(parentDir, entry);
    if (!statSync(entryPath).isDirectory()) continue;

    if (!existsSync(join(entryPath, "06-final.tmj"))) continue;

    for (const nestedEntry of readdirSync(entryPath)) {
      renameSync(join(entryPath, nestedEntry), join(parentDir, nestedEntry));
    }
    rmSync(entryPath, { recursive: true, force: true });
    break;
  }
}

main().catch((err) => {
  console.error("\nWorld generation failed:", err);
  process.exit(1);
});
