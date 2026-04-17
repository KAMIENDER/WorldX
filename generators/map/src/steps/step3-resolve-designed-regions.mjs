import { normalizeWorldDesign } from "../../../../orchestrator/src/world-design-utils.mjs";
import { geminiProVision } from "../models/gemini-pro.mjs";
import { editImage } from "../models/gemini-flash-img.mjs";
import { loadPrompt } from "../utils/prompt-loader.mjs";
import { drawBoundingBoxes, getImageSize } from "../utils/image-utils.mjs";
import {
  COLOR_SPECS,
  MAX_BATCH_SIZE,
  chunkArray,
  extractRegionBoxesFromMarkedImage,
} from "../utils/overlay-extraction.mjs";

const REGION_COLOR = "rgba(255,0,255,0.95)";
const REGION_BOX_STYLE = {
  lineWidth: 6,
  fontSize: 18,
  labelTextColor: "#ffffff",
  labelBgColor: "rgba(255,0,255,0.95)",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function cloneRegions(regions) {
  return JSON.parse(JSON.stringify(regions));
}

function buildRegionBoxes(regions) {
  return regions
    .filter((r) => r.topLeft && r.bottomRight)
    .map((r) => ({
      x: r.topLeft.x,
      y: r.topLeft.y,
      w: r.bottomRight.x - r.topLeft.x,
      h: r.bottomRight.y - r.topLeft.y,
      color: REGION_COLOR,
      label: r.id,
    }));
}

function prepareDesignedRegions(worldDesign) {
  console.log("[Step 3] Preparing predesigned regions...");
  const normalized = normalizeWorldDesign(worldDesign);
  const regions = (normalized.regions || []).map((region) => ({
    id: region.id,
    name: region.name,
    description: region.description,
    type: region.type,
    enterable: region.enterable,
    shapeConstraint: region.shapeConstraint,
    placementHint: region.placementHint,
    visualDescription: region.visualDescription,
    actions: (region.interactions || []).map((interaction) => interaction.id),
    adjacentRegions: [],
    interactions: region.interactions || [],
  }));

  console.log(`[Step 3] Using ${regions.length} predesigned regions.`);
  for (const region of regions) {
    console.log(
      `[Step 3]   Region: ${region.id} (${region.name}) — ${region.actions?.length || 0} actions`,
    );
  }

  return regions;
}

// ─── Nano Banana batch overlay + image-diff extraction ──────────────────────

async function processBatch({ batchIndex, regions, userPrompt, mapDescription, compressedMap, save }) {
  const IMAGE_EDIT_TIMEOUT_MS = parseInt(
    process.env.STEP3_OVERLAY_TIMEOUT_MS || "240000", 10,
  );

  const colorAssignments = regions.map((region, index) => ({
    region,
    color: COLOR_SPECS[index],
  }));

  const regionList = colorAssignments
    .map(({ region }, index) =>
      [
        `${index + 1}. ${region.name} (${region.id})`,
        `   - 类型：${region.type}${region.enterable ? " / 可进入" : ""}`,
        `   - 位置提示：${region.placementHint || "未指定"}`,
        `   - 外观提示：${region.visualDescription || region.description || "未指定"}`,
        `   - 说明：${region.description || "无"}`,
      ].join("\n"),
    )
    .join("\n");

  const colorLegend = colorAssignments
    .map(
      ({ region, color }) =>
        `- ${region.id}: 使用 ${color.label}，色值 ${color.rgba}，对应 RGB(${color.rgb.join(", ")})`,
    )
    .join("\n");

  const prompt = loadPrompt("step3-overlay-generation.md", {
    userPrompt,
    mapDescription,
    regionList,
    colorLegend,
  });

  console.log(`[Step 3] Batch ${batchIndex}: marking ${regions.length} regions with Nano Banana...`);
  colorAssignments.forEach(({ region, color }) => {
    console.log(
      `[Step 3]   ${region.id} -> ${color.label} RGB(${color.rgb.join(", ")})`,
    );
  });

  const markedBuffer = await editImage(prompt, compressedMap, {
    imageSize: "1K",
    logStep: `Step 3 overlay batch ${batchIndex}`,
    requestTimeoutMs: IMAGE_EDIT_TIMEOUT_MS,
  });
  save(`03-overlay-batch-${batchIndex}.png`, markedBuffer);
  console.log(
    `[Step 3] Batch ${batchIndex}: overlay saved (${Math.round(markedBuffer.length / 1024)}KB)`,
  );

  const detectedRegions = await extractRegionBoxesFromMarkedImage(
    compressedMap,
    markedBuffer,
    colorAssignments,
  );

  if (detectedRegions.length === 0) {
    console.log(`[Step 3] Batch ${batchIndex}: no regions detected from overlay diff`);
  } else {
    console.log(`[Step 3] Batch ${batchIndex}: detected ${detectedRegions.length} region(s)`);
    detectedRegions.forEach((region) => {
      console.log(
        `[Step 3]   ${region.id}: (${region.topLeft.x},${region.topLeft.y}) -> (${region.bottomRight.x},${region.bottomRight.y})`,
      );
    });
  }

  return { batchIndex, detectedRegions };
}

// ─── Main export ────────────────────────────────────────────────────────────

/**
 * Locate predesigned regions on the map using Nano Banana color overlays + image diff,
 * then run a single Gemini Pro confirmation pass to drop clearly wrong regions.
 * @param {Buffer} compressedBuffer - compressed map PNG
 * @param {object} worldDesign
 * @param {string} userPrompt
 * @param {(name: string, data: any) => void} save
 * @returns {{ preparedRegions: object[], regions: object[], annotatedImage: Buffer, reviewPassed: boolean, attempts: number, droppedRegionIds: string[] }}
 */
export async function resolveDesignedRegions(compressedBuffer, worldDesign, userPrompt, save) {
  const preparedRegions = prepareDesignedRegions(worldDesign);
  if (preparedRegions.length === 0) {
    console.log("[Step 3] No predesigned regions for this world; skipping localization.");
    return {
      preparedRegions,
      regions: [],
      annotatedImage: compressedBuffer,
      reviewPassed: true,
      attempts: 0,
      droppedRegionIds: [],
    };
  }

  const regions = cloneRegions(preparedRegions);
  const mapDescription = worldDesign.mapDescription || userPrompt;

  // ── Phase A: Batch overlay via Nano Banana ──
  console.log(`[Step 3] Locating ${regions.length} regions via color overlay...`);
  const batches = chunkArray(regions, MAX_BATCH_SIZE);
  console.log(`[Step 3] Split into ${batches.length} batch(es), max ${MAX_BATCH_SIZE} per batch`);

  const batchResults = await Promise.all(
    batches.map((batchRegions, idx) =>
      processBatch({
        batchIndex: idx + 1,
        regions: batchRegions,
        userPrompt,
        mapDescription,
        compressedMap: compressedBuffer,
        save,
      }),
    ),
  );

  const detectedRegions = batchResults.flatMap((r) => r.detectedRegions);
  const detectedMap = new Map(detectedRegions.map((d) => [d.id, d]));

  for (const region of regions) {
    const detected = detectedMap.get(region.id);
    if (detected) {
      region.topLeft = detected.topLeft;
      region.bottomRight = detected.bottomRight;
    }
  }

  const locatedRegions = regions.filter((r) => r.topLeft && r.bottomRight);
  const missingIds = regions
    .filter((r) => !r.topLeft || !r.bottomRight)
    .map((r) => r.id);

  if (missingIds.length > 0) {
    console.warn(`[Step 3] Regions not detected from overlays (will be dropped): ${missingIds.join(", ")}`);
  }
  console.log(`[Step 3] Overlay extraction: ${locatedRegions.length}/${regions.length} regions located`);

  if (locatedRegions.length === 0) {
    console.error("[Step 3] No regions detected from any overlay batch.");
    return {
      preparedRegions,
      regions: [],
      annotatedImage: compressedBuffer,
      reviewPassed: false,
      attempts: 1,
      droppedRegionIds: regions.map((r) => r.id),
    };
  }

  // ── Phase B: Draw annotated image for confirmation ──
  const boxes = buildRegionBoxes(locatedRegions);
  const annotatedImage = await drawBoundingBoxes(compressedBuffer, boxes, REGION_BOX_STYLE);
  save("03-regions-attempt-1.png", annotatedImage);

  // ── Phase C: Single Gemini Pro confirmation pass ──
  const CONFIRM_TIMEOUT_MS = parseInt(
    process.env.STEP3_CONFIRM_TIMEOUT_MS || process.env.STEP3_REVIEW_TIMEOUT_MS || "90000", 10,
  );

  const regionsList = locatedRegions
    .map((r) =>
      `- ${r.id}: ${r.name} (${r.type}) (${r.topLeft.x},${r.topLeft.y})→(${r.bottomRight.x},${r.bottomRight.y})`,
    )
    .join("\n");

  const { width, height } = await getImageSize(compressedBuffer);
  const confirmPrompt = loadPrompt("step3-confirm-regions.md", {
    regionsList,
    imageWidth: width,
    imageHeight: height,
    userPrompt,
  });

  let confirmResult;
  try {
    console.log("[Step 3] Running single confirmation pass with Gemini Pro...");
    const raw = await geminiProVision(confirmPrompt, [compressedBuffer, annotatedImage], {
      logStep: "Step 3 confirm",
      requestTimeoutMs: CONFIRM_TIMEOUT_MS,
    });
    const match = raw.match(/\{[\s\S]*\}/);
    confirmResult = match ? JSON.parse(match[0]) : { pass: true, problematic_region_ids: [] };
  } catch (e) {
    console.warn(`[Step 3] Confirmation call failed (keeping all detected regions): ${e.message}`);
    confirmResult = { pass: true, problematic_region_ids: [] };
  }

  const problematicIds = confirmResult.problematic_region_ids || [];
  const droppedRegionIds = [...missingIds, ...problematicIds];

  if (confirmResult.pass) {
    console.log("[Step 3] Confirmation passed — all detected regions accepted.");
    return {
      preparedRegions,
      regions: locatedRegions,
      annotatedImage,
      reviewPassed: true,
      attempts: 1,
      droppedRegionIds: missingIds,
    };
  }

  console.log(`[Step 3] Confirmation flagged ${problematicIds.length} problematic region(s): ${problematicIds.join(", ")}`);
  const finalRegions = locatedRegions.filter((r) => !problematicIds.includes(r.id));

  let finalAnnotatedImage = annotatedImage;
  if (problematicIds.length > 0 && finalRegions.length > 0) {
    const finalBoxes = buildRegionBoxes(finalRegions);
    finalAnnotatedImage = await drawBoundingBoxes(compressedBuffer, finalBoxes, REGION_BOX_STYLE);
  } else if (finalRegions.length === 0) {
    finalAnnotatedImage = compressedBuffer;
  }

  return {
    preparedRegions,
    regions: finalRegions,
    annotatedImage: finalAnnotatedImage,
    reviewPassed: false,
    attempts: 1,
    droppedRegionIds,
  };
}

/**
 * Scale region coordinates from compressed to original resolution.
 */
export function scaleRegions(regions, origWidth, compressedWidth) {
  const ratio = origWidth / compressedWidth;
  return regions
    .filter((r) => r.topLeft && r.bottomRight)
    .map((r) => ({
      ...r,
      topLeft: {
        x: Math.round(r.topLeft.x * ratio),
        y: Math.round(r.topLeft.y * ratio),
      },
      bottomRight: {
        x: Math.round(r.bottomRight.x * ratio),
        y: Math.round(r.bottomRight.y * ratio),
      },
    }));
}
