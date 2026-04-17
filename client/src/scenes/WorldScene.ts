import Phaser from "phaser";
import { EventBus } from "../EventBus";
import { MapManager } from "../systems/MapManager";
import { PathfindingManager } from "../systems/PathfindingManager";
import { CharacterMovement } from "../systems/CharacterMovement";
import { PlaybackController } from "../systems/PlaybackController";
import { CameraController } from "../systems/CameraController";
import { CharacterSprite } from "../objects/CharacterSprite";
import { MBTI_COLORS, getCharacterColor, actionToEmoji, createCharacterDisplayMetrics } from "../config/game-config";
import { apiClient } from "../ui/services/api-client";
import type { DialogueEventData, SimulationEvent } from "../types/api";

export class WorldScene extends Phaser.Scene {
  private mapManager!: MapManager;
  private pathfinder!: PathfindingManager;
  private characterMovement!: CharacterMovement;
  private characterSprites: Map<string, CharacterSprite> = new Map();
  private playbackController!: PlaybackController;
  private cameraController!: CameraController;
  private eventBus!: Phaser.Events.EventEmitter;
  private entityLayer!: Phaser.GameObjects.Container;
  private dialogueQueue: Array<{
    speaker: string;
    content: string;
    innerMonologue?: string;
    participants?: string[];
    sourceEvent?: SimulationEvent;
    emitDialogueEvent?: boolean;
  }> = [];
  private dialoguePlaybackTimer: Phaser.Time.TimerEvent | null = null;
  private dialogueEventChain: Promise<void> = Promise.resolve();
  private mapPixelWidth = 8192;
  private mapPixelHeight = 4608;
  private walkableOverlay: Phaser.GameObjects.Graphics | null = null;
  private regionBoundsOverlay: Phaser.GameObjects.Container | null = null;
  private mainAreaPointsOverlay: Phaser.GameObjects.Graphics | null = null;
  private interactiveObjectsOverlay: Phaser.GameObjects.Container | null = null;

  constructor() {
    super("WorldScene");
  }

  create() {
    console.log("[WorldScene] create() called");
    this.eventBus = EventBus.instance;
    let tiledJSON: any = null;

    try {
      tiledJSON = this.cache.json.get("world-map");
      this.mapManager = new MapManager();
      this.mapManager.loadFromTiledJSON(tiledJSON);
      console.log("[WorldScene] Map parsed:", this.mapManager.getAllLocationIds());
    } catch (e) {
      console.error("[WorldScene] Failed to parse map:", e);
      this.mapManager = new MapManager();
    }

    const hasBg = this.textures.exists("world-base");
    let bgWidth = 8192;
    let bgHeight = 4608;
    if (hasBg) {
      const bg = this.add.image(0, 0, "world-base").setOrigin(0, 0);
      bgWidth = bg.width;
      bgHeight = bg.height;
      console.log(`[WorldScene] Background loaded: ${bgWidth}x${bgHeight}`);
    } else {
      console.warn("[WorldScene] Background texture not found, using fallback");
      this.add.rectangle(bgWidth / 2, bgHeight / 2, bgWidth, bgHeight, 0x2d4a3e);
    }

    this.entityLayer = this.add.container(0, 0);
    this.entityLayer.setDepth(10);
    this.mapPixelWidth = bgWidth;
    this.mapPixelHeight = bgHeight;

    this.pathfinder = new PathfindingManager(this.mapManager);

    const initialCenter = { x: bgWidth / 2, y: bgHeight / 2 };
    this.cameraController = new CameraController(this, bgWidth, bgHeight, initialCenter);
    console.log("[WorldScene] Camera centered on:", initialCenter);

    this.characterMovement = new CharacterMovement(
      this.mapManager,
      this.pathfinder,
      this.characterSprites
    );

    this.playbackController = new PlaybackController(this.eventBus);
    this.playbackController.on("event", this.handleSimEvent, this);

    this.eventBus.on("follow_character", (charId: string) => {
      const sprite = this.characterSprites.get(charId);
      if (sprite) this.cameraController.followCharacter(sprite);
    });
    this.eventBus.on("unfollow_character", () => {
      this.cameraController.stopFollowing();
    });
    this.eventBus.on("dev_advance_tick", () => {
      this.playbackController.devAdvanceTick();
    });
    this.eventBus.on("set_auto_play", (enabled: boolean) => {
      this.playbackController.setAutoPlay(enabled);
    });
    this.eventBus.on("set_tick_interval", (intervalMs: number) => {
      this.playbackController.setTickIntervalMs(intervalMs);
    });
    const onToggleWalkableOverlay = (visible: boolean) => {
      this.setWalkableOverlayVisible(visible);
    };
    const onToggleRegionBoundsOverlay = (visible: boolean) => {
      this.setRegionBoundsOverlayVisible(visible);
    };
    const onToggleMainAreaPointsOverlay = (visible: boolean) => {
      this.setMainAreaPointsOverlayVisible(visible);
    };
    const onToggleInteractiveObjectsOverlay = (visible: boolean) => {
      this.setInteractiveObjectsOverlayVisible(visible);
    };
    this.eventBus.on("toggle_debug_walkable_overlay", onToggleWalkableOverlay);
    this.eventBus.on("toggle_debug_region_bounds_overlay", onToggleRegionBoundsOverlay);
    this.eventBus.on("toggle_debug_main_area_points_overlay", onToggleMainAreaPointsOverlay);
    this.eventBus.on("toggle_debug_interactive_objects_overlay", onToggleInteractiveObjectsOverlay);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.eventBus.off("toggle_debug_walkable_overlay", onToggleWalkableOverlay);
      this.eventBus.off("toggle_debug_region_bounds_overlay", onToggleRegionBoundsOverlay);
      this.eventBus.off("toggle_debug_main_area_points_overlay", onToggleMainAreaPointsOverlay);
      this.eventBus.off("toggle_debug_interactive_objects_overlay", onToggleInteractiveObjectsOverlay);
    });

    this.initAsync();
  }

  private async initAsync() {
    try {
      const worldInfo = await apiClient.getWorldInfo();
      this.mapManager.setMainAreaPoints(worldInfo.mainAreaPoints || []);
      if (this.regionBoundsOverlay || this.mainAreaPointsOverlay || this.interactiveObjectsOverlay) {
        this.refreshDebugOverlays();
      }
    } catch (e) {
      console.warn("[WorldScene] Failed to load world navigation:", e);
    }

    try {
      await this.initCharacters();
    } catch (e) {
      console.warn("[WorldScene] Failed to load characters:", e);
    }

    try {
      await this.playbackController.initialize();
    } catch (e) {
      console.warn("[WorldScene] Failed to initialize playback:", e);
    }

    console.log("[WorldScene] Async init complete, sprites:", this.characterSprites.size);
  }

  private async initCharacters() {
    const characters = await apiClient.getCharacters();
    console.log("[WorldScene] Got characters:", characters.length);
    const zoom = this.cameras.main.zoom;
    const displayMetrics = createCharacterDisplayMetrics(this.mapPixelWidth, this.mapPixelHeight);
    const mainAreaOccupants = new Map<string, string[]>();

    for (const char of characters) {
      if (char.location !== "main_area" || !char.mainAreaPointId) continue;
      const occupants = mainAreaOccupants.get(char.mainAreaPointId) ?? [];
      occupants.push(char.id);
      mainAreaOccupants.set(char.mainAreaPointId, occupants);
    }

    for (const [index, char] of characters.entries()) {
      const pos =
        (char.location === "main_area" && char.mainAreaPointId
          ? this.mapManager.getMainAreaPlacement(char.mainAreaPointId, char.id, {
              occupantIds: mainAreaOccupants.get(char.mainAreaPointId) ?? [char.id],
            })
          : null) ||
        this.mapManager.getRandomWalkablePointInLocation(char.location, {
          preferInset: this.mapManager.isPinnedLocation(char.location),
        }) ||
        { x: 400, y: 300 };

      const color = char.mbti
        ? (MBTI_COLORS[char.mbti] || getCharacterColor(index))
        : getCharacterColor(index);

      const sprite = new CharacterSprite(this, pos.x, pos.y, {
        characterId: char.id,
        name: char.name,
        mbti: char.mbti || "",
        color,
        displayMetrics,
      });

      sprite.currentLocationId = char.location;
      sprite.mainAreaPointId = char.mainAreaPointId ?? null;
      sprite.profileAnchor = char.anchor || null;
      sprite.setCurrentAction(char.currentAction);
      sprite.setActionIcon(actionToEmoji(char.currentAction));
      sprite.setMovementAnchor({
        x: pos.x,
        y: pos.y,
        pinned: this.mapManager.isPinnedLocation(char.location) || !!char.anchor,
      });
      sprite.syncOverlayZoom(zoom);
      sprite.enableClick((id) => this.eventBus.emit("character_clicked", id));

      this.entityLayer.add(sprite);
      this.characterSprites.set(char.id, sprite);
    }
  }

  private handleSimEvent(event: SimulationEvent) {
    switch (event.type) {
      case "movement": {
        const destination = event.data?.to ?? event.data?.toLocation ?? event.location;
        if (event.actorId && destination) {
          const sprite = this.characterSprites.get(event.actorId);
          sprite?.setCurrentAction(null);
          sprite?.setActionIcon("");
          const pointId =
            typeof event.data?.toPointId === "string" ? event.data.toPointId : null;
          this.characterMovement.moveToLocation(event.actorId, destination, {
            force: true,
            mainAreaPointId: pointId,
          });
          this.maybeShowActionMonologue(event);
        }
        break;
      }

      case "action_start": {
        const sprite = this.characterSprites.get(event.actorId!);
        const actionId = event.data?.action ?? event.data?.interactionId ?? event.data?.actionType ?? null;
        if (sprite) {
          sprite.setCurrentAction(actionId);
          sprite.setActionIcon(actionToEmoji(actionId));
        }
        const objectId = event.data?.objectId ?? event.targetId;
        if (objectId && event.actorId && event.data?.actionType === "interact_object") {
          this.characterMovement.moveToObject(event.actorId, objectId);
        }
        this.maybeShowActionMonologue(event);
        break;
      }

      case "action_end": {
        const sprite = this.characterSprites.get(event.actorId!);
        if (sprite) {
          sprite.setCurrentAction(null);
          sprite.setActionIcon("");
        }
        break;
      }

      case "dialogue":
        this.dialogueEventChain = this.dialogueEventChain
          .then(() => this.handleDialogue(event))
          .catch((error) => {
            console.warn("[WorldScene] Failed to handle dialogue event:", error);
          });
        break;

      case "event_triggered":
        this.eventBus.emit("global_event", event);
        break;
    }

    this.eventBus.emit("sim_event", event);
  }

  private async handleDialogue(event: SimulationEvent) {
    const dialogue = event.data as DialogueEventData;
    if (!dialogue) return;

    if (dialogue.participants?.length === 2) {
      const [idA, idB] = dialogue.participants;
      const spriteA = this.characterSprites.get(idA);
      const spriteB = this.characterSprites.get(idB);
      if (dialogue.phase === "complete") {
        this.setDialogueActionState(dialogue.participants, "post_dialogue");
      } else {
        this.setDialogueActionState(dialogue.participants, "in_conversation");
      }
      if (spriteA && spriteB) {
        if (dialogue.phase === "turn" && dialogue.turnIndexStart === 0) {
          const runtimePatch = await this.characterMovement.approachForDialogue(idA, idB);
          if (runtimePatch?.mainAreaPointId) {
            void apiClient.patchCharacterRuntimeState(idA, runtimePatch).catch((error) => {
              console.warn("[WorldScene] Failed to persist dialogue landing point:", error);
            });
          }
        } else {
          spriteA.faceTowards(spriteB.x, spriteB.y);
          spriteB.faceTowards(spriteA.x, spriteA.y);
        }
      }
    }

    if (dialogue.phase === "turn" && dialogue.turns?.length) {
      dialogue.turns.forEach((turn, index) => {
        this.dialogueQueue.push({
          speaker: turn.speaker,
          content: turn.content,
          innerMonologue: turn.innerMonologue,
          participants: dialogue.participants,
          sourceEvent: event,
          emitDialogueEvent: index === 0,
        });
      });
      this.playNextDialogueTurn();
    } else if (dialogue.phase === "complete" && dialogue.participants?.length) {
      this.time.delayedCall(1200, () => {
        for (const participantId of dialogue.participants || []) {
          const sprite = this.characterSprites.get(participantId);
          if (!sprite || sprite.currentAction !== "post_dialogue") continue;
          sprite.setCurrentAction(null);
          sprite.setActionIcon("");
        }
      });
    }

    if (dialogue.phase === "complete") {
      this.eventBus.emit("dialogue", event);
    }
  }

  private setDialogueActionState(participantIds: string[], action: string | null) {
    for (const participantId of participantIds) {
      const sprite = this.characterSprites.get(participantId);
      if (!sprite) continue;
      sprite.setCurrentAction(action);
      sprite.setActionIcon(actionToEmoji(action));
    }
  }

  private playNextDialogueTurn() {
    if (this.dialoguePlaybackTimer || this.dialogueQueue.length === 0) {
      return;
    }

    const nextTurn = this.dialogueQueue.shift();
    if (!nextTurn) return;

    const baseDuration = Math.max(3000, nextTurn.content.length * 150);

    if (nextTurn.participants?.length === 2) {
      const [idA, idB] = nextTurn.participants;
      const spriteA = this.characterSprites.get(idA);
      const spriteB = this.characterSprites.get(idB);
      if (spriteA && spriteB) {
        spriteA.faceTowards(spriteB.x, spriteB.y);
        spriteB.faceTowards(spriteA.x, spriteA.y);
      }
    }

    const sprite = this.characterSprites.get(nextTurn.speaker);
    if (sprite) {
      sprite.showBubble(nextTurn.content, baseDuration);
    }
    if (nextTurn.emitDialogueEvent && nextTurn.sourceEvent) {
      this.eventBus.emit("dialogue", nextTurn.sourceEvent);
    }

    const innerMonologue = nextTurn.innerMonologue;
    const monologueGap = innerMonologue ? 2600 : 0;
    if (sprite && innerMonologue) {
      this.time.delayedCall(baseDuration + 200, () => {
        sprite.showMonologue(`…${innerMonologue}`);
      });
    }

    this.dialoguePlaybackTimer = this.time.delayedCall(
      baseDuration + 400 + monologueGap,
      () => {
        this.dialoguePlaybackTimer = null;
        this.playNextDialogueTurn();
      },
    );
  }

  private maybeShowActionMonologue(event: SimulationEvent): void {
    const monologue = event.innerMonologue;
    if (!monologue || !event.actorId) return;
    const sprite = this.characterSprites.get(event.actorId);
    if (!sprite) return;
    this.time.delayedCall(350, () => {
      sprite.showMonologue(`…${monologue}`);
    });
  }

  private setWalkableOverlayVisible(visible: boolean): void {
    if (visible && !this.walkableOverlay) {
      this.walkableOverlay = this.buildWalkableOverlay();
    }
    this.walkableOverlay?.setVisible(visible);
  }

  private setRegionBoundsOverlayVisible(visible: boolean): void {
    if (visible && !this.regionBoundsOverlay) {
      this.regionBoundsOverlay = this.buildRegionBoundsOverlay();
    }
    this.regionBoundsOverlay?.setVisible(visible);
  }

  private setMainAreaPointsOverlayVisible(visible: boolean): void {
    if (visible && !this.mainAreaPointsOverlay) {
      this.mainAreaPointsOverlay = this.buildMainAreaPointsOverlay();
    }
    this.mainAreaPointsOverlay?.setVisible(visible);
  }

  private setInteractiveObjectsOverlayVisible(visible: boolean): void {
    if (visible && !this.interactiveObjectsOverlay) {
      this.interactiveObjectsOverlay = this.buildInteractiveObjectsOverlay();
    }
    this.interactiveObjectsOverlay?.setVisible(visible);
  }

  private refreshDebugOverlays(): void {
    const regionBoundsVisible = this.regionBoundsOverlay?.visible ?? false;
    const mainAreaPointsVisible = this.mainAreaPointsOverlay?.visible ?? false;
    const interactiveObjectsVisible = this.interactiveObjectsOverlay?.visible ?? false;

    this.regionBoundsOverlay?.destroy(true);
    this.regionBoundsOverlay = null;
    this.mainAreaPointsOverlay?.destroy();
    this.mainAreaPointsOverlay = null;
    this.interactiveObjectsOverlay?.destroy(true);
    this.interactiveObjectsOverlay = null;

    if (regionBoundsVisible) {
      this.regionBoundsOverlay = this.buildRegionBoundsOverlay();
      this.regionBoundsOverlay.setVisible(true);
    }
    if (mainAreaPointsVisible) {
      this.mainAreaPointsOverlay = this.buildMainAreaPointsOverlay();
      this.mainAreaPointsOverlay.setVisible(true);
    }
    if (interactiveObjectsVisible) {
      this.interactiveObjectsOverlay = this.buildInteractiveObjectsOverlay();
      this.interactiveObjectsOverlay.setVisible(true);
    }
  }

  private buildWalkableOverlay(): Phaser.GameObjects.Graphics {
    const graphics = this.add.graphics();
    graphics.setDepth(4);
    graphics.fillStyle(0x4da3ff, 0.22);
    graphics.lineStyle(1, 0x7db8ff, 0.16);

    const tileSize = this.mapManager.tileSize;
    for (let gy = 0; gy < this.mapManager.gridHeight; gy++) {
      let runStart: number | null = null;
      for (let gx = 0; gx <= this.mapManager.gridWidth; gx++) {
        const walkable = gx < this.mapManager.gridWidth && this.mapManager.isWalkable(gx, gy);
        if (walkable) {
          if (runStart == null) runStart = gx;
          continue;
        }
        if (runStart == null) continue;

        const width = (gx - runStart) * tileSize;
        const x = runStart * tileSize;
        const y = gy * tileSize;
        graphics.fillRect(x, y, width, tileSize);
        graphics.strokeRect(x, y, width, tileSize);
        runStart = null;
      }
    }

    return graphics;
  }

  private buildRegionBoundsOverlay(): Phaser.GameObjects.Container {
    const container = this.add.container(0, 0);
    container.setDepth(16);

    const boxes = this.add.graphics();
    boxes.lineStyle(2, 0xffd166, 0.95);
    boxes.fillStyle(0xffd166, 0.08);
    container.add(boxes);

    for (const location of this.mapManager.getVisibleLocations()) {
      boxes.fillRect(location.x, location.y, location.width, location.height);
      boxes.strokeRect(location.x, location.y, location.width, location.height);

      const label = this.add.text(
        location.x + 6,
        Math.max(6, location.y - 22),
        location.name || location.id,
        {
          fontSize: "14px",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          color: "#ffe7a8",
          backgroundColor: "rgba(0, 0, 0, 0.65)",
          padding: { left: 6, right: 6, top: 3, bottom: 3 },
          stroke: "#000000",
          strokeThickness: 2,
        },
      );
      label.setDepth(17);
      container.add(label);
    }

    return container;
  }

  private buildMainAreaPointsOverlay(): Phaser.GameObjects.Graphics {
    const pointMarkers = this.add.graphics();
    pointMarkers.setDepth(16);
    pointMarkers.lineStyle(2, 0xffffff, 0.92);
    pointMarkers.fillStyle(0x4da3ff, 0.95);

    for (const point of this.mapManager.getMainAreaPoints()) {
      pointMarkers.fillCircle(point.x, point.y, 6);
      pointMarkers.strokeCircle(point.x, point.y, 6);
      pointMarkers.fillStyle(0xe8f4ff, 0.95);
      pointMarkers.fillCircle(point.x, point.y, 2);
      pointMarkers.fillStyle(0x4da3ff, 0.95);
    }

    return pointMarkers;
  }

  private buildInteractiveObjectsOverlay(): Phaser.GameObjects.Container {
    const container = this.add.container(0, 0);
    container.setDepth(16);

    const boxes = this.add.graphics();
    boxes.lineStyle(2, 0x55efc4, 0.95);
    boxes.fillStyle(0x55efc4, 0.1);
    container.add(boxes);

    for (const object of this.mapManager.getInteractiveObjects()) {
      boxes.fillRect(object.x, object.y, object.width, object.height);
      boxes.strokeRect(object.x, object.y, object.width, object.height);

      const label = this.add.text(
        object.x + 6,
        Math.max(6, object.y - 22),
        object.name || object.objectId,
        {
          fontSize: "14px",
          fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
          color: "#c8fff0",
          backgroundColor: "rgba(0, 0, 0, 0.65)",
          padding: { left: 6, right: 6, top: 3, bottom: 3 },
          stroke: "#000000",
          strokeThickness: 2,
        },
      );
      label.setDepth(17);
      container.add(label);
    }

    return container;
  }

  update(_time: number, delta: number) {
    this.cameraController?.update();
    this.pathfinder?.update();
    this.playbackController?.update(delta);
    this.characterMovement?.updateAmbientMovement(performance.now());
    const zoom = this.cameras.main.zoom;
    for (const sprite of this.characterSprites.values()) {
      sprite.syncOverlayZoom(zoom);
    }
    if (this.entityLayer) {
      this.entityLayer.list.sort((a, b) => {
        const ay = a instanceof CharacterSprite ? a.getSortFootY() : (a as Phaser.GameObjects.Sprite).y || 0;
        const by = b instanceof CharacterSprite ? b.getSortFootY() : (b as Phaser.GameObjects.Sprite).y || 0;
        return ay - by;
      });
    }
  }
}
