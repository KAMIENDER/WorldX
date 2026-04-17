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

const ELEMENT_COLOR = "rgba(0,200,200,0.95)";
const ELEMENT_BOX_STYLE = {
  lineWidth: 4,
  fontSize: 16,
  labelTextColor: "#ffffff",
  labelBgColor: "rgba(0,200,200,0.95)",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function prepareInteractiveElements(worldDesign) {
  console.log("[Step 3.2] Preparing interactive elements...");
  const normalized = normalizeWorldDesign(worldDesign);
  const elements = (normalized.interactiveElements || []).map((el) => ({
    id: el.id,
    name: el.name,
    description: el.description,
    visualDescription: el.visualDescription,
    placementHint: el.placementHint,
    interactions: el.interactions || [],
  }));

  console.log(`[Step 3.2] Found ${elements.length} interactive element(s).`);
  for (const el of elements) {
    console.log(
      `[Step 3.2]   Element: ${el.id} (${el.name}) — ${el.interactions?.length || 0} interactions`,
    );
  }

  return elements;
}

function buildElementBoxes(elements) {
  return elements
    .filter((e) => e.topLeft && e.bottomRight)
    .map((e) => ({
      x: e.topLeft.x,
      y: e.topLeft.y,
      w: e.bottomRight.x - e.topLeft.x,
      h: e.bottomRight.y - e.topLeft.y,
      color: ELEMENT_COLOR,
      label: e.id,
    }));
}

// ─── Nano Banana batch overlay ──────────────────────────────────────────────

async function processBatch({ batchIndex, elements, userPrompt, mapDescription, compressedMap, save }) {
  const IMAGE_EDIT_TIMEOUT_MS = parseInt(
    process.env.STEP3_2_OVERLAY_TIMEOUT_MS || process.env.STEP3_OVERLAY_TIMEOUT_MS || "240000", 10,
  );

  const colorAssignments = elements.map((element, index) => ({
    region: element,
    color: COLOR_SPECS[index],
  }));

  const elementList = colorAssignments
    .map(({ region: element }, index) =>
      [
        `${index + 1}. ${element.name} (${element.id})`,
        `   - 位置提示：${element.placementHint || "未指定"}`,
        `   - 外观提示：${element.visualDescription || element.description || "未指定"}`,
        `   - 说明：${element.description || "无"}`,
      ].join("\n"),
    )
    .join("\n");

  const colorLegend = colorAssignments
    .map(
      ({ region: element, color }) =>
        `- ${element.id}: 使用 ${color.label}，色值 ${color.rgba}，对应 RGB(${color.rgb.join(", ")})`,
    )
    .join("\n");

  const prompt = loadPrompt("step3.2-overlay-generation.md", {
    userPrompt,
    mapDescription,
    elementList,
    colorLegend,
  });

  console.log(`[Step 3.2] Batch ${batchIndex}: marking ${elements.length} element(s) with Nano Banana...`);
  colorAssignments.forEach(({ region: element, color }) => {
    console.log(
      `[Step 3.2]   ${element.id} -> ${color.label} RGB(${color.rgb.join(", ")})`,
    );
  });

  const markedBuffer = await editImage(prompt, compressedMap, {
    imageSize: "1K",
    logStep: `Step 3.2 overlay batch ${batchIndex}`,
    requestTimeoutMs: IMAGE_EDIT_TIMEOUT_MS,
  });
  save(`03.2-overlay-batch-${batchIndex}.png`, markedBuffer);
  console.log(
    `[Step 3.2] Batch ${batchIndex}: overlay saved (${Math.round(markedBuffer.length / 1024)}KB)`,
  );

  const detectedElements = await extractRegionBoxesFromMarkedImage(
    compressedMap,
    markedBuffer,
    colorAssignments,
  );

  if (detectedElements.length === 0) {
    console.log(`[Step 3.2] Batch ${batchIndex}: no elements detected from overlay diff`);
  } else {
    console.log(`[Step 3.2] Batch ${batchIndex}: detected ${detectedElements.length} element(s)`);
    detectedElements.forEach((el) => {
      console.log(
        `[Step 3.2]   ${el.id}: (${el.topLeft.x},${el.topLeft.y}) -> (${el.bottomRight.x},${el.bottomRight.y})`,
      );
    });
  }

  return { batchIndex, detectedElements };
}

// ─── Main export ────────────────────────────────────────────────────────────

/**
 * Locate interactive elements on the map using Nano Banana color overlays + image diff,
 * then run a single Gemini Pro confirmation pass to drop clearly wrong elements.
 * @param {Buffer} compressedBuffer - compressed map PNG
 * @param {object} worldDesign
 * @param {string} userPrompt
 * @param {(name: string, data: any) => void} save
 * @returns {{ elements: object[], annotatedImage: Buffer, reviewPassed: boolean, attempts: number, droppedElementIds: string[] }}
 */
export async function locateElements(compressedBuffer, worldDesign, userPrompt, save) {
  const preparedElements = prepareInteractiveElements(worldDesign);
  if (preparedElements.length === 0) {
    console.log("[Step 3.2] No interactive elements for this world; skipping localization.");
    return {
      elements: [],
      annotatedImage: compressedBuffer,
      reviewPassed: true,
      attempts: 0,
      droppedElementIds: [],
    };
  }

  const elements = JSON.parse(JSON.stringify(preparedElements));
  const mapDescription = worldDesign.mapDescription || userPrompt;

  // ── Phase A: Batch overlay via Nano Banana ──
  console.log(`[Step 3.2] Locating ${elements.length} element(s) via color overlay...`);
  const batches = chunkArray(elements, MAX_BATCH_SIZE);
  console.log(`[Step 3.2] Split into ${batches.length} batch(es), max ${MAX_BATCH_SIZE} per batch`);

  const batchResults = await Promise.all(
    batches.map((batchElements, idx) =>
      processBatch({
        batchIndex: idx + 1,
        elements: batchElements,
        userPrompt,
        mapDescription,
        compressedMap: compressedBuffer,
        save,
      }),
    ),
  );

  const detectedElements = batchResults.flatMap((r) => r.detectedElements);
  const detectedMap = new Map(detectedElements.map((d) => [d.id, d]));

  for (const element of elements) {
    const detected = detectedMap.get(element.id);
    if (detected) {
      element.topLeft = detected.topLeft;
      element.bottomRight = detected.bottomRight;
    }
  }

  const locatedElements = elements.filter((e) => e.topLeft && e.bottomRight);
  const missingIds = elements
    .filter((e) => !e.topLeft || !e.bottomRight)
    .map((e) => e.id);

  if (missingIds.length > 0) {
    console.warn(`[Step 3.2] Elements not detected from overlays (will be dropped): ${missingIds.join(", ")}`);
  }
  console.log(`[Step 3.2] Overlay extraction: ${locatedElements.length}/${elements.length} element(s) located`);

  if (locatedElements.length === 0) {
    console.error("[Step 3.2] No elements detected from any overlay batch.");
    return {
      elements: [],
      annotatedImage: compressedBuffer,
      reviewPassed: false,
      attempts: 1,
      droppedElementIds: elements.map((e) => e.id),
    };
  }

  // ── Phase B: Draw annotated image for confirmation ──
  const boxes = buildElementBoxes(locatedElements);
  const annotatedImage = await drawBoundingBoxes(compressedBuffer, boxes, ELEMENT_BOX_STYLE);
  save("03.2-elements-attempt-1.png", annotatedImage);

  // ── Phase C: Single Gemini Pro confirmation pass ──
  const CONFIRM_TIMEOUT_MS = parseInt(
    process.env.STEP3_2_CONFIRM_TIMEOUT_MS || process.env.STEP3_CONFIRM_TIMEOUT_MS || "90000", 10,
  );

  const elementsList = locatedElements
    .map((e) =>
      `- ${e.id}: ${e.name} (${e.topLeft.x},${e.topLeft.y})→(${e.bottomRight.x},${e.bottomRight.y})`,
    )
    .join("\n");

  const { width, height } = await getImageSize(compressedBuffer);
  const confirmPrompt = loadPrompt("step3.2-confirm-elements.md", {
    elementsList,
    imageWidth: width,
    imageHeight: height,
    userPrompt,
  });

  let confirmResult;
  try {
    console.log("[Step 3.2] Running single confirmation pass with Gemini Pro...");
    const raw = await geminiProVision(confirmPrompt, [compressedBuffer, annotatedImage], {
      logStep: "Step 3.2 confirm",
      requestTimeoutMs: CONFIRM_TIMEOUT_MS,
    });
    const match = raw.match(/\{[\s\S]*\}/);
    confirmResult = match ? JSON.parse(match[0]) : { pass: true, problematic_element_ids: [] };
  } catch (e) {
    console.warn(`[Step 3.2] Confirmation call failed (keeping all detected elements): ${e.message}`);
    confirmResult = { pass: true, problematic_element_ids: [] };
  }

  const problematicIds = confirmResult.problematic_element_ids || [];
  const droppedElementIds = [...missingIds, ...problematicIds];

  if (confirmResult.pass) {
    console.log("[Step 3.2] Confirmation passed — all detected elements accepted.");
    return {
      elements: locatedElements,
      annotatedImage,
      reviewPassed: true,
      attempts: 1,
      droppedElementIds: missingIds,
    };
  }

  console.log(`[Step 3.2] Confirmation flagged ${problematicIds.length} problematic element(s): ${problematicIds.join(", ")}`);
  const finalElements = locatedElements.filter((e) => !problematicIds.includes(e.id));

  let finalAnnotatedImage = annotatedImage;
  if (problematicIds.length > 0 && finalElements.length > 0) {
    const finalBoxes = buildElementBoxes(finalElements);
    finalAnnotatedImage = await drawBoundingBoxes(compressedBuffer, finalBoxes, ELEMENT_BOX_STYLE);
  } else if (finalElements.length === 0) {
    finalAnnotatedImage = compressedBuffer;
  }

  return {
    elements: finalElements,
    annotatedImage: finalAnnotatedImage,
    reviewPassed: false,
    attempts: 1,
    droppedElementIds,
  };
}

/**
 * Scale element coordinates from compressed to original resolution.
 */
export function scaleElements(elements, origWidth, compressedWidth) {
  const ratio = origWidth / compressedWidth;
  return elements
    .filter((e) => e.topLeft && e.bottomRight)
    .map((e) => ({
      ...e,
      topLeft: {
        x: Math.round(e.topLeft.x * ratio),
        y: Math.round(e.topLeft.y * ratio),
      },
      bottomRight: {
        x: Math.round(e.bottomRight.x * ratio),
        y: Math.round(e.bottomRight.y * ratio),
      },
    }));
}
