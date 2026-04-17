import { generateImage } from "../models/gemini-flash-img.mjs";
import { geminiProVisionJSON } from "../models/gemini-pro.mjs";
import { arkChat } from "../models/ark-client.mjs";
import { loadPrompt } from "../utils/prompt-loader.mjs";
import { resizeImage } from "../utils/image-utils.mjs";
import { getMapImageSizeLabel } from "../utils/generation-config.mjs";

function formatWorldActionSummary(worldDesign) {
  const worldActions = worldDesign?.worldActions || [];
  if (worldActions.length === 0) {
    return "必须补充至少一个有世界语义的全局功能；不要只用发呆或移动来代替。";
  }

  return worldActions
    .map((action, index) =>
      `${index + 1}. ${action.name}(${action.id})：${action.description || "全场景可执行动作"}`,
    )
    .join("\n");
}

function formatRegionSummary(worldDesign) {
  const regions = worldDesign?.regions || [];
  if (regions.length === 0) {
    return "本地图不要求单独的功能区标注，重点表现整个场景的统一功能与风貌。";
  }

  return regions
    .map((region, index) => {
      const interactions = (region.interactions || [])
        .map((interaction) => `${interaction.name}(${interaction.id})`)
        .join("、");
      const modeLabel =
        region.type === "building"
          ? region.enterable
            ? "可进入建筑"
            : "景观建筑"
          : "户外区域";
      return [
        `${index + 1}. ${region.name}(${region.id})`,
        `   - 类型：${modeLabel}`,
        `   - 位置提示：${region.placementHint || "未指定"}`,
        `   - 外观提示：${region.visualDescription || region.description || "未指定"}`,
        `   - 主要功能：${interactions || "无"}`,
      ].join("\n");
    })
    .join("\n");
}

function formatMapPlanSummary(worldDesign) {
  const mapPlan = worldDesign?.mapPlan || {};
  return [
    `- buildingMode: ${mapPlan.buildingMode || "mostly_enterable"}`,
    `- compositionNotes: ${mapPlan.compositionNotes || "无"}`,
    `- worldFunctionSummary: ${mapPlan.worldFunctionSummary || "无"}`,
    `- regionDesignNotes: ${mapPlan.regionDesignNotes || "无"}`,
  ].join("\n");
}

/**
 * Generate the source map with self-feedback loop.
 * Allows up to MAX_RETRIES modifications + 1 final review.
 * @param {string} userPrompt
 * @param {object} worldDesign
 * @param {(name: string, data: any) => void} save - callback to persist intermediate artifacts
 * @returns {{ buffer: Buffer, reviewPassed: boolean, attempts: number }}
 */
export async function generateMap(userPrompt, worldDesign, save) {
  const MAX_RETRIES = parseInt(process.env.STEP1_MAX_RETRIES || process.env.MAX_RETRIES || "3", 10);
  const MAP_IMAGE_SIZE = getMapImageSizeLabel();
  const GENERATE_TIMEOUT_MS = parseInt(process.env.STEP1_GENERATE_TIMEOUT_MS || "180000", 10);
  const REVIEW_TIMEOUT_MS = parseInt(process.env.STEP1_REVIEW_TIMEOUT_MS || "90000", 10);
  const ADJUST_TIMEOUT_MS = parseInt(process.env.STEP1_ADJUST_TIMEOUT_MS || "90000", 10);
  let additionalConstraints = "";
  let mapBuffer = null;
  const totalAttempts = MAX_RETRIES + 1;
  const mapPlanSummary = formatMapPlanSummary(worldDesign);
  const worldActionSummary = formatWorldActionSummary(worldDesign);
  const regionSummary = formatRegionSummary(worldDesign);

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    console.log(`[Step 1] Generating map (attempt ${attempt}/${totalAttempts})...`);

    const prompt = loadPrompt("step1-map-generation.md", {
      userPrompt,
      mapPlanSummary,
      worldActionSummary,
      regionSummary,
      additionalConstraints,
    });

    mapBuffer = await generateImage(prompt, {
      aspectRatio: "16:9",
      imageSize: MAP_IMAGE_SIZE,
      logStep: "Step 1 generate",
      requestTimeoutMs: GENERATE_TIMEOUT_MS,
    });
    console.log(`[Step 1] Generated image: ${mapBuffer.length} bytes`);
    save(`01-map-attempt-${attempt}.png`, mapBuffer);

    console.log(`[Step 1] Reviewing (${attempt}/${totalAttempts})...`);
    const { buffer: smallBuf } = await resizeImage(mapBuffer, 1024);

    const reviewPrompt = loadPrompt("step1-map-review.md", {
      userPrompt,
      mapPlanSummary,
      worldActionSummary,
      regionSummary,
    });

    let review;
    let reviewError = null;
    try {
      review = await geminiProVisionJSON(reviewPrompt, [smallBuf], {
        logStep: "Step 1 review",
        requestTimeoutMs: REVIEW_TIMEOUT_MS,
      });
    } catch (e) {
      reviewError = e;
      console.warn(`[Step 1] Review failed on attempt ${attempt}: ${e.message}`);
      review = { pass: false, issues: [`Review request failed: ${e.message}`], promptAdjustments: [] };
    }

    if (review.pass) {
      console.log("[Step 1] Review result: pass=true, issues=0");
      console.log(`[Step 1] Map passed review on attempt ${attempt}.`);
      return { buffer: mapBuffer, reviewPassed: true, attempts: attempt };
    }

    if (reviewError) {
      console.log(`[Step 1] Review unavailable on attempt ${attempt}, retrying generation.`);
      continue;
    }

    console.log(`[Step 1] Review failed. Issues: ${review.issues?.join("; ")}`);

    if (attempt < totalAttempts && review.promptAdjustments?.length) {
      const adjustmentRequest = `以下是对地图生成prompt的审查反馈，请将这些调整建议整合成额外的约束条件（用中文，简洁明了）：\n${review.promptAdjustments.join("\n")}`;
      const newConstraints = await arkChat([
        { role: "user", content: adjustmentRequest },
      ], { logStep: "Step 1 adjust", requestTimeoutMs: ADJUST_TIMEOUT_MS });
      additionalConstraints += `\n${newConstraints}`;
      console.log(`[Step 1] Accumulated constraints: ${additionalConstraints.slice(0, 300)}`);
    }
  }

  console.warn(`[Step 1] All ${totalAttempts} attempts exhausted, review never passed.`);
  return { buffer: mapBuffer, reviewPassed: false, attempts: totalAttempts };
}
