import type { SceneConfig } from "../types/index.js";

const LEGACY_DURATION_TICK_MINUTES = 15;
const DEFAULT_DURATION_MINUTES = 30;

export type DurationLike = {
  duration?: number;
  durationMinutes?: number;
};

export function getDurationMinutes(value: DurationLike): number {
  if (Number.isFinite(value.durationMinutes) && value.durationMinutes! > 0) {
    return Math.max(1, Math.round(value.durationMinutes!));
  }

  if (Number.isFinite(value.duration) && value.duration! > 0) {
    return Math.max(1, Math.round(value.duration! * LEGACY_DURATION_TICK_MINUTES));
  }

  return DEFAULT_DURATION_MINUTES;
}

export function getDurationTicks(value: DurationLike, sceneConfig: SceneConfig): number {
  return Math.max(
    1,
    Math.ceil(getDurationMinutes(value) / sceneConfig.tickDurationMinutes),
  );
}
