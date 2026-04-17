import { arkChatJSON } from "../models/ark-client.mjs";
import { loadPrompt } from "../utils/prompt-loader.mjs";

/**
 * Evaluate whether the user's description is feasible for current AI capabilities.
 * @returns {{ feasible: boolean, reason?: string, suggestions?: string[], buildingCount: number, outdoorAreaCount: number }}
 */
export async function evaluateComplexity(userPrompt) {
  console.log("[Step 0] Evaluating map complexity...");

  const systemPrompt = loadPrompt("step0-complexity.md", { userPrompt });

  const result = await arkChatJSON([
    { role: "system", content: "你是一个游戏地图复杂度评估专家，请严格按照要求返回 JSON。" },
    { role: "user", content: systemPrompt },
  ], { logStep: "Step 0" });

  console.log(`[Step 0] Result: feasible=${result.feasible}, buildings=${result.buildingCount}, outdoors=${result.outdoorAreaCount}`);

  if (!result.feasible) {
    console.log(`[Step 0] REJECTED: ${result.reason}`);
    if (result.suggestions?.length) {
      console.log(`[Step 0] Suggestions: ${result.suggestions.join("; ")}`);
    }
  }

  return result;
}
