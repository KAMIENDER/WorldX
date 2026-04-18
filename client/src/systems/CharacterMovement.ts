import { MapManager } from "./MapManager";
import { PathfindingManager } from "./PathfindingManager";
import Phaser from "phaser";
import { CharacterSprite } from "../objects/CharacterSprite";

const LOCAL_WANDER_RADIUS_TILES = 4;
const ANCHORED_ELEMENT_WANDER_RADIUS_TILES = 2;
const DIALOGUE_FACE_TO_FACE_HEIGHT_RATIO = 0.8;
const DIALOGUE_APPROACH_SEARCH_PADDING_TILES = 8;
const DIALOGUE_APPROACH_MAX_CANDIDATES = 24;

export class CharacterMovement {
  private ambientMoveCooldownUntil: Map<string, number> = new Map();
  private nextAmbientScanAt = 0;

  constructor(
    private mapManager: MapManager,
    private pathfinder: PathfindingManager,
    private sprites: Map<string, CharacterSprite>
  ) {}

  async moveToLocation(
    charId: string,
    locationId: string,
    options: { force?: boolean; mainAreaPointId?: string | null } = {},
  ): Promise<void> {
    if (locationId === "main_area" && options.mainAreaPointId) {
      await this.moveToMainAreaPoint(charId, options.mainAreaPointId, options);
      return;
    }

    const sprite = this.sprites.get(charId);
    if (!sprite) return;
    if (sprite.isMoving) {
      if (!options.force) return;
      sprite.stopMoving();
    }

    const target = this.mapManager.getRandomWalkablePointInLocation(locationId, {
      preferInset: this.mapManager.isPinnedLocation(locationId),
    });
    if (!target) return;

    const path = await this.pathfinder.findPath(sprite.x, sprite.y, target.x, target.y);
    if (path && path.length > 0) {
      await this.walkSprite(sprite, path, () => {
        sprite.currentLocationId = locationId;
        sprite.mainAreaPointId = null;
        sprite.setMovementAnchor({
          x: target.x,
          y: target.y,
          pinned: this.mapManager.isPinnedLocation(locationId),
        });
        this.ambientMoveCooldownUntil.set(charId, performance.now() + this.randomAmbientDelay());
      });
    } else {
      sprite.setPosition(target.x, target.y);
      sprite.currentLocationId = locationId;
      sprite.mainAreaPointId = null;
      sprite.setMovementAnchor({
        x: target.x,
        y: target.y,
        pinned: this.mapManager.isPinnedLocation(locationId),
      });
      this.ambientMoveCooldownUntil.set(charId, performance.now() + this.randomAmbientDelay());
    }
  }

  async moveToMainAreaPoint(
    charId: string,
    pointId: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const sprite = this.sprites.get(charId);
    if (!sprite) return;
    if (sprite.isMoving) {
      if (!options.force) return;
      sprite.stopMoving();
    }

    const target = this.mapManager.getMainAreaPlacement(pointId, charId, {
      occupantIds: this.getMainAreaPointOccupants(pointId, charId),
    });
    if (!target) return;

    const onArrive = () => {
      sprite.currentLocationId = "main_area";
      sprite.mainAreaPointId = pointId;
      sprite.setMovementAnchor({
        x: target.x,
        y: target.y,
        pinned: false,
      });
      this.ambientMoveCooldownUntil.set(charId, performance.now() + this.randomAmbientDelay());
    };

    const path = await this.pathfinder.findPath(sprite.x, sprite.y, target.x, target.y);
    if (path && path.length > 0) {
      await this.walkSprite(sprite, path, onArrive);
    } else {
      sprite.setPosition(target.x, target.y);
      onArrive();
    }
  }

  async moveToObject(charId: string, objectId: string): Promise<void> {
    const sprite = this.sprites.get(charId);
    if (!sprite || sprite.isMoving) return;

    const path = await this.pathfinder.findPathToObject(sprite.x, sprite.y, objectId);
    if (path && path.length > 0) {
      await this.walkSprite(sprite, path);
    }
  }

  async idleWander(charId: string): Promise<void> {
    const sprite = this.sprites.get(charId);
    if (!sprite || !sprite.canAmbientWander()) return;

    const currentLoc = sprite.currentLocationId;
    const pinned = this.mapManager.isPinnedLocation(currentLoc);
    const isProfileAnchored = !!sprite.profileAnchor;
    const anchoredInMainArea = currentLoc === "main_area" && !!sprite.mainAreaPointId && !!sprite.movementAnchor;
    const useFixedAnchor = (pinned || anchoredInMainArea || isProfileAnchored) && !!sprite.movementAnchor;
    const origin = useFixedAnchor && sprite.movementAnchor
      ? sprite.movementAnchor
      : { x: sprite.x, y: sprite.y };

    const wanderRadius = isProfileAnchored && sprite.profileAnchor?.type === "element"
      ? ANCHORED_ELEMENT_WANDER_RADIUS_TILES
      : LOCAL_WANDER_RADIUS_TILES;

    const target = this.mapManager.getRandomWalkablePointNear(
      origin.x,
      origin.y,
      wanderRadius,
      pinned ? currentLoc : undefined,
    );
    if (!target) return;

    const path = await this.pathfinder.findPath(sprite.x, sprite.y, target.x, target.y);
    if (path && path.length > 0 && path.length < 15) {
      await this.walkSprite(sprite, path, () => {
        if (!useFixedAnchor) {
          sprite.setMovementAnchor({
            x: target.x,
            y: target.y,
            pinned: false,
          });
        }
        this.ambientMoveCooldownUntil.set(charId, performance.now() + this.randomAmbientDelay());
      });
    }
  }

  async approachForDialogue(
    initiatorId: string,
    responderId: string,
  ): Promise<{ mainAreaPointId: string | null } | null> {
    const initiator = this.sprites.get(initiatorId);
    const responder = this.sprites.get(responderId);
    if (!initiator || !responder) return null;

    if (initiator.isMoving) initiator.stopMoving();
    if (responder.isMoving) responder.stopMoving();

    const distance = Phaser.Math.Distance.Between(
      initiator.x,
      initiator.y,
      responder.x,
      responder.y,
    );
    const desiredDistance = this.getDesiredDialogueDistance(initiator, responder);
    const mainAreaDialogueTargets = this.getMainAreaDialogueTargets(
      initiatorId,
      responderId,
      initiator,
      responder,
      desiredDistance,
    );
    if (mainAreaDialogueTargets) {
      const initiatorMoved = await this.moveSpriteToDialogueTarget(
        initiator,
        mainAreaDialogueTargets.initiator,
      );
      const responderMoved = await this.moveSpriteToDialogueTarget(
        responder,
        mainAreaDialogueTargets.responder,
      );
      if (initiatorMoved && responderMoved) {
        this.applyMainAreaLanding(initiator, responder.mainAreaPointId!, mainAreaDialogueTargets.initiator);
        this.applyMainAreaLanding(responder, responder.mainAreaPointId!, mainAreaDialogueTargets.responder);
        this.facePair(initiator, responder);
        return this.buildDialoguePersistencePatch(initiator, responder);
      }
    }

    if (distance <= desiredDistance) {
      const persistencePatch = this.buildDialoguePersistencePatch(initiator, responder);
      if (persistencePatch?.mainAreaPointId) {
        initiator.mainAreaPointId = persistencePatch.mainAreaPointId;
        initiator.setMovementAnchor({
          x: initiator.x,
          y: initiator.y,
          pinned: false,
        });
      }
      this.facePair(initiator, responder);
      return persistencePatch;
    }

    const approachPath = await this.findDialogueApproachPath(initiator, responder);
    if (!approachPath) {
      this.facePair(initiator, responder);
      return null;
    }

    await this.moveSpriteToDialoguePoint(initiator, approachPath);
    const persistencePatch = this.buildDialoguePersistencePatch(initiator, responder);
    if (persistencePatch?.mainAreaPointId) {
      initiator.mainAreaPointId = persistencePatch.mainAreaPointId;
      initiator.setMovementAnchor({
        x: initiator.x,
        y: initiator.y,
        pinned: false,
      });
    }
    this.syncSpriteLocation(initiator);
    this.facePair(initiator, responder);
    return persistencePatch;
  }

  updateAmbientMovement(now: number): void {
    if (now < this.nextAmbientScanAt) return;
    this.nextAmbientScanAt = now + 1000;

    for (const [charId, sprite] of this.sprites) {
      if (!sprite.canAmbientWander()) continue;

      const nextMoveAt = this.ambientMoveCooldownUntil.get(charId);
      if (nextMoveAt == null) {
        this.ambientMoveCooldownUntil.set(charId, now + this.randomAmbientDelay());
        continue;
      }
      if (now < nextMoveAt) continue;

      this.ambientMoveCooldownUntil.set(charId, now + this.randomAmbientDelay());
      void this.idleWander(charId);
    }
  }

  private randomAmbientDelay(): number {
    return 4500 + Math.random() * 4500;
  }

  private async findDialogueApproachPath(
    initiator: CharacterSprite,
    responder: CharacterSprite,
  ): Promise<{ x: number; y: number }[] | null> {
    const desiredDistance = this.getDesiredDialogueDistance(initiator, responder);
    const searchRadiusTiles = Math.max(
      6,
      Math.ceil(desiredDistance / this.mapManager.tileSize) + DIALOGUE_APPROACH_SEARCH_PADDING_TILES,
    );
    const approachVector = new Phaser.Math.Vector2(
      initiator.x - responder.x,
      initiator.y - responder.y,
    );
    if (approachVector.lengthSq() < 1) {
      approachVector.set(0, 1);
    } else {
      approachVector.normalize();
    }
    const desiredTarget = {
      x: responder.x + approachVector.x * desiredDistance,
      y: responder.y + approachVector.y * desiredDistance,
    };
    const minDistance = Math.max(this.mapManager.tileSize * 1.5, desiredDistance * 0.55);
    const primaryMaxDistance = desiredDistance * 1.35;
    const fallbackMaxDistance = desiredDistance * 1.8;
    const candidates = this.mapManager.getWalkableCandidatesNear(
      responder.x,
      responder.y,
      searchRadiusTiles,
      responder.currentLocationId,
    );
    const shortlist =
      this.rankDialogueApproachCandidates(candidates, desiredTarget, desiredDistance)
        .filter((candidate) => candidate.distance >= minDistance && candidate.distance <= primaryMaxDistance)
        .slice(0, DIALOGUE_APPROACH_MAX_CANDIDATES);
    const fallbackShortlist =
      shortlist.length > 0
        ? shortlist
        : this.rankDialogueApproachCandidates(candidates, desiredTarget, desiredDistance)
            .filter((candidate) => candidate.distance >= minDistance && candidate.distance <= fallbackMaxDistance)
            .slice(0, DIALOGUE_APPROACH_MAX_CANDIDATES);

    for (const candidate of fallbackShortlist) {
      const path = await this.pathfinder.findPath(
        initiator.x,
        initiator.y,
        candidate.x,
        candidate.y,
      );
      if (!path || path.length === 0) continue;
      return path;
    }

    return null;
  }

  private getMainAreaDialogueTargets(
    initiatorId: string,
    responderId: string,
    initiator: CharacterSprite,
    responder: CharacterSprite,
    desiredDistance: number,
  ): { initiator: { x: number; y: number }; responder: { x: number; y: number } } | null {
    if (responder.currentLocationId !== "main_area" || !responder.mainAreaPointId) {
      return null;
    }
    return this.mapManager.getMainAreaDialoguePairPlacements(
      responder.mainAreaPointId,
      initiatorId,
      responderId,
      desiredDistance,
      {
        x: initiator.x - responder.x,
        y: initiator.y - responder.y,
      },
    );
  }

  private buildDialoguePersistencePatch(
    initiator: CharacterSprite,
    responder: CharacterSprite,
  ): { mainAreaPointId: string | null } | null {
    if (
      initiator.currentLocationId === "main_area" &&
      responder.currentLocationId === "main_area" &&
      responder.mainAreaPointId
    ) {
      return { mainAreaPointId: responder.mainAreaPointId };
    }
    return null;
  }

  private getDesiredDialogueDistance(
    initiator: CharacterSprite,
    responder: CharacterSprite,
  ): number {
    const referenceHeight =
      (initiator.getWorldBodyHeight() + responder.getWorldBodyHeight()) / 2;
    return Math.max(this.mapManager.tileSize, referenceHeight * DIALOGUE_FACE_TO_FACE_HEIGHT_RATIO);
  }

  private rankDialogueApproachCandidates(
    candidates: Array<{ x: number; y: number; distance: number }>,
    desiredTarget: { x: number; y: number },
    desiredDistance: number,
  ): Array<{ x: number; y: number; distance: number }> {
    return [...candidates].sort((a, b) => {
      const scoreA =
        Phaser.Math.Distance.Between(a.x, a.y, desiredTarget.x, desiredTarget.y) +
        Math.abs(a.distance - desiredDistance) * 0.8;
      const scoreB =
        Phaser.Math.Distance.Between(b.x, b.y, desiredTarget.x, desiredTarget.y) +
        Math.abs(b.distance - desiredDistance) * 0.8;
      return scoreA - scoreB;
    });
  }

  private async moveSpriteToDialoguePoint(
    sprite: CharacterSprite,
    path: { x: number; y: number }[],
  ): Promise<void> {
    const destination = path[path.length - 1];
    if (!destination) return;
    if (Phaser.Math.Distance.Between(sprite.x, sprite.y, destination.x, destination.y) <= 2) {
      return;
    }
    await this.walkSprite(sprite, path);
  }

  private async moveSpriteToDialogueTarget(
    sprite: CharacterSprite,
    target: { x: number; y: number },
  ): Promise<boolean> {
    const distance = Phaser.Math.Distance.Between(sprite.x, sprite.y, target.x, target.y);
    if (distance <= 2) {
      sprite.setPosition(target.x, target.y);
      return true;
    }
    const path = await this.pathfinder.findPath(sprite.x, sprite.y, target.x, target.y);
    if (!path || path.length === 0) {
      return false;
    }
    await this.moveSpriteToDialoguePoint(sprite, path);
    return true;
  }

  private syncSpriteLocation(sprite: CharacterSprite): void {
    const locationId = this.mapManager.getLocationAtPixel(sprite.x, sprite.y);
    if (locationId) {
      sprite.currentLocationId = locationId;
      if (locationId !== "main_area") {
        sprite.mainAreaPointId = null;
      }
      if (locationId === "main_area" && sprite.mainAreaPointId) {
        return;
      }
      sprite.setMovementAnchor({
        x: sprite.x,
        y: sprite.y,
        pinned: this.mapManager.isPinnedLocation(locationId),
      });
    }
  }

  private applyMainAreaLanding(
    sprite: CharacterSprite,
    pointId: string,
    target: { x: number; y: number },
  ): void {
    sprite.setPosition(target.x, target.y);
    sprite.currentLocationId = "main_area";
    sprite.mainAreaPointId = pointId;
    sprite.setMovementAnchor({
      x: target.x,
      y: target.y,
      pinned: false,
    });
  }

  private facePair(a: CharacterSprite, b: CharacterSprite): void {
    a.faceTowards(b.x, b.y);
    b.faceTowards(a.x, a.y);
  }

  private async walkSprite(
    sprite: CharacterSprite,
    path: { x: number; y: number }[],
    onComplete?: () => void,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      sprite.walkAlongPath(path, () => {
        onComplete?.();
        resolve();
      });
    });
  }

  private getMainAreaPointOccupants(pointId: string, includeCharId: string): string[] {
    const occupants = new Set<string>([includeCharId]);
    for (const [charId, sprite] of this.sprites) {
      if (charId === includeCharId) continue;
      if (sprite.currentLocationId !== "main_area") continue;
      if (sprite.mainAreaPointId !== pointId) continue;
      occupants.add(charId);
    }
    return [...occupants];
  }
}
