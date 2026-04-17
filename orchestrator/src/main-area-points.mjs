const DEFAULT_POINT_RATIO = parseFloat(process.env.MAIN_AREA_POINT_RATIO || "0.1");
const MIN_POINT_SPACING_TILES = parseInt(process.env.MAIN_AREA_POINT_MIN_TILES || "6", 10);
const MAX_POINT_SPACING_TILES = parseInt(process.env.MAIN_AREA_POINT_MAX_TILES || "14", 10);
const SNAP_SEARCH_RADIUS_TILES = parseInt(process.env.MAIN_AREA_POINT_SNAP_TILES || "3", 10);
const MAX_MAIN_AREA_POINTS = parseInt(process.env.MAIN_AREA_POINT_MAX_COUNT || "18", 10);

export function buildMainAreaPoints({ tmj, collisionLayer, regions = [], elementObjects = [] }) {
  const tileSize = tmj?.tilewidth || 32;
  const gridWidth = tmj?.width || 0;
  const gridHeight = tmj?.height || 0;
  const collisionData = Array.isArray(collisionLayer?.data) ? collisionLayer.data : [];
  if (!gridWidth || !gridHeight || collisionData.length !== gridWidth * gridHeight) {
    return [];
  }

  const worldWidth = gridWidth * tileSize;
  const worldHeight = gridHeight * tileSize;
  const averageDimension = (worldWidth + worldHeight) / 2;
  const baseSpacingPx = clamp(
    averageDimension * DEFAULT_POINT_RATIO,
    MIN_POINT_SPACING_TILES * tileSize,
    MAX_POINT_SPACING_TILES * tileSize,
  );

  const passes = [
    { spacingPx: baseSpacingPx, blockedClearanceTiles: 2, regionMarginPx: tileSize * 2 },
    { spacingPx: Math.max(tileSize * 5, baseSpacingPx * 0.82), blockedClearanceTiles: 1, regionMarginPx: tileSize },
  ];

  for (const pass of passes) {
    const rawPoints = generateCandidates({
      collisionData,
      gridWidth,
      gridHeight,
      tileSize,
      worldWidth,
      worldHeight,
      regions,
      spacingPx: pass.spacingPx,
      blockedClearanceTiles: pass.blockedClearanceTiles,
      regionMarginPx: pass.regionMarginPx,
    });
    if (rawPoints.length > 0) {
      const points = relabelPoints(
        prunePoints(rawPoints, {
          maxPoints: MAX_MAIN_AREA_POINTS,
          worldWidth,
          worldHeight,
        }),
      );
      const withAdjacency = attachAdjacency(points, collisionData, gridWidth, gridHeight, tileSize, pass.spacingPx);
      const elementPoints = buildElementApproachPoints(elementObjects, collisionData, gridWidth, gridHeight, tileSize);
      if (elementPoints.length > 0) {
        return attachAdjacency(
          [...withAdjacency, ...elementPoints],
          collisionData, gridWidth, gridHeight, tileSize, pass.spacingPx,
        );
      }
      return withAdjacency;
    }
  }

  // Even with no grid-based points, generate element approach points
  const elementPoints = buildElementApproachPoints(elementObjects, collisionData, gridWidth, gridHeight, tileSize);
  if (elementPoints.length > 0) {
    return attachAdjacency(elementPoints, collisionData, gridWidth, gridHeight, tileSize, baseSpacingPx);
  }

  return [];
}

function buildElementApproachPoints(elementObjects, collisionData, gridWidth, gridHeight, tileSize) {
  const points = [];
  for (const obj of elementObjects) {
    if (!obj.x || !obj.y || !obj.width || !obj.height) continue;
    const approachX = obj.x + obj.width / 2;
    const approachY = obj.y + obj.height + tileSize;
    const snapped = snapToWalkableOutsideBox(
      approachX, approachY, obj, collisionData, gridWidth, gridHeight, tileSize,
    );
    if (!snapped) continue;
    const objProps = {};
    (obj.properties || []).forEach((p) => { objProps[p.name] = p.value; });
    const elementId = objProps.objectId || obj.name?.toLowerCase().replace(/\s+/g, "_") || `element_${obj.id}`;
    points.push({
      id: `element_${elementId}`,
      name: `${obj.name || elementId}附近`,
      x: snapped.x,
      y: snapped.y,
      adjacentPointIds: [],
    });
  }
  return points;
}

function snapToWalkableOutsideBox(x, y, box, collisionData, gridWidth, gridHeight, tileSize) {
  const center = {
    gx: clampInt(Math.floor(x / tileSize), 0, gridWidth - 1),
    gy: clampInt(Math.floor(y / tileSize), 0, gridHeight - 1),
  };
  const margin = tileSize * 0.5;
  const boxLeft = box.x - margin;
  const boxTop = box.y - margin;
  const boxRight = box.x + box.width + margin;
  const boxBottom = box.y + box.height + margin;

  const maxRadius = SNAP_SEARCH_RADIUS_TILES + 3;
  let best = null;

  for (let radius = 0; radius <= maxRadius; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const gx = center.gx + dx;
        const gy = center.gy + dy;
        if (!isWalkableTile(gx, gy, collisionData, gridWidth, gridHeight)) continue;
        const px = gx * tileSize + tileSize / 2;
        const py = gy * tileSize + tileSize / 2;
        if (px >= boxLeft && px <= boxRight && py >= boxTop && py <= boxBottom) continue;
        const score = Math.hypot(px - x, py - y);
        if (!best || score < best.score) {
          best = { gx, gy, x: px, y: py, score };
        }
      }
    }
    if (best) return best;
  }

  return null;
}

function generateCandidates(params) {
  const {
    collisionData,
    gridWidth,
    gridHeight,
    tileSize,
    worldWidth,
    worldHeight,
    regions,
    spacingPx,
    blockedClearanceTiles,
    regionMarginPx,
  } = params;

  const accepted = [];
  const startX = spacingPx / 2;
  const startY = spacingPx / 2;
  const minPointDistance = spacingPx * 0.72;

  for (let y = startY; y < worldHeight; y += spacingPx) {
    for (let x = startX; x < worldWidth; x += spacingPx) {
      const snapped = snapCandidateToWalkable(
        x,
        y,
        collisionData,
        gridWidth,
        gridHeight,
        tileSize,
      );
      if (!snapped) continue;
      if (!hasWalkableClearance(snapped.gx, snapped.gy, collisionData, gridWidth, gridHeight, blockedClearanceTiles)) {
        continue;
      }
      if (isInsideExpandedRegion(snapped.x, snapped.y, regions, regionMarginPx)) {
        continue;
      }
      if (accepted.some((point) => distance(point, snapped) < minPointDistance)) {
        continue;
      }
      accepted.push({
        x: snapped.x,
        y: snapped.y,
      });
    }
  }

  return accepted;
}

function attachAdjacency(points, collisionData, gridWidth, gridHeight, tileSize, spacingPx) {
  const adjacencyDistance = Math.max(tileSize * 3, spacingPx * 1.45);
  const pointMap = new Map(points.map((point) => [point.id, point]));

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i];
      const b = points[j];
      if (distance(a, b) > adjacencyDistance) continue;
      if (!hasWalkableCorridor(a, b, collisionData, gridWidth, gridHeight, tileSize)) continue;
      pointMap.get(a.id)?.adjacentPointIds.push(b.id);
      pointMap.get(b.id)?.adjacentPointIds.push(a.id);
    }
  }

  for (const point of points) {
    const current = pointMap.get(point.id);
    if (!current || current.adjacentPointIds.length > 0) continue;

    const nearest = points
      .filter((candidate) => candidate.id !== point.id)
      .sort((a, b) => distance(point, a) - distance(point, b))
      .find(Boolean);
    if (!nearest) continue;
    current.adjacentPointIds.push(nearest.id);
    pointMap.get(nearest.id)?.adjacentPointIds.push(point.id);
  }

  return points.map((point) => ({
    ...point,
    adjacentPointIds: Array.from(new Set(point.adjacentPointIds)).sort(),
  }));
}

function prunePoints(points, { maxPoints, worldWidth, worldHeight }) {
  if (points.length <= maxPoints) return points;

  const center = { x: worldWidth / 2, y: worldHeight / 2 };
  const remaining = [...points];
  const selected = [];

  remaining.sort((a, b) => distance(a, center) - distance(b, center));
  selected.push(remaining.shift());

  while (selected.length < maxPoints && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const point = remaining[i];
      const score = selected.reduce(
        (minDistance, chosen) => Math.min(minDistance, distance(point, chosen)),
        Number.POSITIVE_INFINITY,
      );
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return selected;
}

function relabelPoints(points) {
  return points.map((point, index) => ({
    id: `main_area_point_${index + 1}`,
    name: `主区域点位${index + 1}`,
    x: point.x,
    y: point.y,
    adjacentPointIds: [],
  }));
}

function snapCandidateToWalkable(x, y, collisionData, gridWidth, gridHeight, tileSize) {
  const center = {
    gx: clampInt(Math.floor(x / tileSize), 0, gridWidth - 1),
    gy: clampInt(Math.floor(y / tileSize), 0, gridHeight - 1),
  };
  let best = null;

  for (let radius = 0; radius <= SNAP_SEARCH_RADIUS_TILES; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const gx = center.gx + dx;
        const gy = center.gy + dy;
        if (!isWalkableTile(gx, gy, collisionData, gridWidth, gridHeight)) continue;
        const snapped = {
          gx,
          gy,
          x: gx * tileSize + tileSize / 2,
          y: gy * tileSize + tileSize / 2,
        };
        const score = Math.hypot(snapped.x - x, snapped.y - y);
        if (!best || score < best.score) {
          best = { ...snapped, score };
        }
      }
    }
    if (best) return best;
  }

  return null;
}

function hasWalkableClearance(gx, gy, collisionData, gridWidth, gridHeight, clearanceTiles) {
  for (let dy = -clearanceTiles; dy <= clearanceTiles; dy++) {
    for (let dx = -clearanceTiles; dx <= clearanceTiles; dx++) {
      if (Math.hypot(dx, dy) > clearanceTiles + 0.25) continue;
      if (!isWalkableTile(gx + dx, gy + dy, collisionData, gridWidth, gridHeight)) {
        return false;
      }
    }
  }
  return true;
}

function isInsideExpandedRegion(x, y, regions, marginPx) {
  return regions.some((region) => {
    const left = region.x - marginPx;
    const top = region.y - marginPx;
    const right = region.x + region.width + marginPx;
    const bottom = region.y + region.height + marginPx;
    return x >= left && x <= right && y >= top && y <= bottom;
  });
}

function hasWalkableCorridor(a, b, collisionData, gridWidth, gridHeight, tileSize) {
  const steps = Math.max(6, Math.ceil(distance(a, b) / (tileSize * 0.75)));
  for (let step = 1; step < steps; step++) {
    const t = step / steps;
    const x = lerp(a.x, b.x, t);
    const y = lerp(a.y, b.y, t);
    const gx = clampInt(Math.floor(x / tileSize), 0, gridWidth - 1);
    const gy = clampInt(Math.floor(y / tileSize), 0, gridHeight - 1);
    if (!isWalkableTile(gx, gy, collisionData, gridWidth, gridHeight)) {
      return false;
    }
  }
  return true;
}

function isWalkableTile(gx, gy, collisionData, gridWidth, gridHeight) {
  if (gx < 0 || gy < 0 || gx >= gridWidth || gy >= gridHeight) return false;
  return collisionData[gy * gridWidth + gx] === 0;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}
