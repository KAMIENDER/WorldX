import type { CharacterState, CharacterProfile } from "../types/index.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const STRENUOUS_ACTIONS = ["explore", "work", "exercise", "build", "repair"];
const REST_ACTIONS = ["idle", "rest", "sleep", "sit", "tea", "drink"];

export function decayNeeds(
  charState: CharacterState,
  profile: CharacterProfile,
  _tick: number,
): Partial<CharacterState> {
  const isStrenuous = STRENUOUS_ACTIONS.some(
    (a) => charState.currentAction?.includes(a),
  );
  const isTraveling = charState.currentAction === "traveling";
  const isResting = REST_ACTIONS.some(
    (a) => charState.currentAction?.includes(a),
  );

  const curiosityDelta = isStrenuous
    ? -(1 + 1.0 * profile.intuitionLevel)
    : -(0.5 + 1.0 * profile.intuitionLevel);
  const energyDelta = isResting ? 2.2 : isStrenuous ? -2.4 : isTraveling ? -1.4 : -0.45;
  const hungerDelta = isStrenuous ? 1.35 : isTraveling ? 0.95 : 0.55;
  const stressDelta =
    charState.hunger >= 80 || charState.energy <= 20
      ? 1.4
      : isResting
        ? -1.0
        : -0.25;

  return {
    curiosity: clamp(charState.curiosity + curiosityDelta, 0, 100),
    energy: clamp(charState.energy + energyDelta, 0, 100),
    hunger: clamp(charState.hunger + hungerDelta, 0, 100),
    stress: clamp(charState.stress + stressDelta, 0, 100),
  };
}
