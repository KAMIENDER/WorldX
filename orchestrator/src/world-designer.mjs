import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { normalizeWorldDesign } from "./world-design-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function designWorld(userPrompt) {
  const { arkChatJSON } = await import("./models/ark-client.mjs");

  const template = readFileSync(join(__dirname, "../prompts/design-world.md"), "utf-8");
  const prompt = template.replace(/\{\{userPrompt\}\}/g, userPrompt);

  console.log("[WorldDesigner] Designing world from prompt...");

  const rawResult = await arkChatJSON({
    systemMessage: "You are an expert world designer for AI social simulations. Always respond with valid JSON.",
    userMessage: prompt,
    temperature: 0.7,
  });
  const result = normalizeWorldDesign(rawResult);

  if (
    !result.worldName ||
    !result.mapDescription ||
    !result.characters?.length ||
    !result.worldActions?.length
  ) {
    throw new Error("WorldDesigner returned incomplete design");
  }

  if (result.characters.length > 8) {
    result.characters = result.characters.slice(0, 8);
  }

  console.log(`[WorldDesigner] Designed world: "${result.worldName}"`);
  console.log(`  Characters: ${result.characters.length}`);
  console.log(`  Regions: ${result.regions?.length || 0}`);
  console.log(`  World actions: ${result.worldActions?.length || 0}`);
  console.log(`  Scene type: ${result.sceneType}`);

  return result;
}
