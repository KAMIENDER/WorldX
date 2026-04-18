import Phaser from "phaser";
import {
  SPRITE_FRAME_HEIGHT,
  SPRITE_FRAME_WIDTH,
  SPRITE_WALK_FRAME_RATE,
  type CharacterDisplayMetrics,
} from "../config/game-config";

type FacingDirection = "down" | "up" | "left" | "right";
const WALK_SPEED_BODY_HEIGHT_RATIO = 1.1;

export interface MovementAnchor {
  x: number;
  y: number;
  pinned: boolean;
}

export class CharacterSprite extends Phaser.GameObjects.Container {
  characterId: string;
  characterName: string;
  mbtiType: string;
  currentLocationId = "";
  mainAreaPointId: string | null = null;
  currentAction: string | null = null;
  isMoving = false;
  movementAnchor: MovementAnchor | null = null;
  profileAnchor: { type: "region" | "element"; targetId: string } | null = null;

  private shadow!: Phaser.GameObjects.Ellipse;
  private bodyCircle: Phaser.GameObjects.Arc | null = null;
  private bodySprite: Phaser.GameObjects.Sprite | null = null;
  private bodyContainer!: Phaser.GameObjects.Container;
  private bubbleContainer!: Phaser.GameObjects.Container;
  private bubbleBg!: Phaser.GameObjects.Graphics;
  private bubbleText!: Phaser.GameObjects.Text;
  private bubbleHideTimer: Phaser.Time.TimerEvent | null = null;
  private currentBubbleVerticalSpan = 0;
  private osBubbleContainer!: Phaser.GameObjects.Container;
  private osBubbleBg!: Phaser.GameObjects.Graphics;
  private osBubbleText!: Phaser.GameObjects.Text;
  private osBubbleHideTimer: Phaser.Time.TimerEvent | null = null;
  private moveTween: Phaser.Tweens.Tween | null = null;
  private idleTween: Phaser.Tweens.Tween | null = null;
  private walkTween: Phaser.Tweens.Tween | null = null;
  private labelRoot: HTMLDivElement | null = null;
  private mbtiEl: HTMLDivElement | null = null;
  private nameRowEl: HTMLDivElement | null = null;
  private nameEl: HTMLDivElement | null = null;
  private actionIconEl: HTMLSpanElement | null = null;
  private hasSprite = false;
  private facing: FacingDirection = "down";
  private overlayZoom = 1;
  private displayMetrics: CharacterDisplayMetrics;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    config: {
      characterId: string;
      name: string;
      mbti: string;
      color: number;
      displayMetrics: CharacterDisplayMetrics;
    }
  ) {
    super(scene, x, y);
    this.characterId = config.characterId;
    this.characterName = config.name;
    this.mbtiType = config.mbti;
    this.displayMetrics = config.displayMetrics;
    this.hasSprite = scene.textures.exists(config.characterId);
    this.createVisuals(config.color);
    const hitW = this.hasSprite ? this.displayMetrics.hitWidth : this.displayMetrics.circleRadius * 2;
    const hitH = this.hasSprite ? this.displayMetrics.hitHeight : this.displayMetrics.circleRadius * 2;
    const hitTopY = this.hasSprite ? this.displayMetrics.hitTopY : -this.displayMetrics.circleRadius;
    this.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(-hitW / 2, hitTopY, hitW, hitH),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });
    scene.add.existing(this);
  }

  private createVisuals(color: number): void {
    const shadowWidth = this.hasSprite ? this.displayMetrics.shadowWidth : this.displayMetrics.circleRadius * 1.3;
    const shadowHeight = this.hasSprite ? this.displayMetrics.shadowHeight : this.displayMetrics.circleRadius * 0.55;
    const shadowOffsetY = this.hasSprite ? this.displayMetrics.shadowOffsetY : this.displayMetrics.circleRadius * 0.65;
    this.shadow = this.scene.add.ellipse(0, shadowOffsetY, shadowWidth, shadowHeight, 0x000000, 0.4);

    if (this.hasSprite) {
      this.createSpriteBody();
    } else {
      this.createCircleBody(color);
    }

    const bubbleAnchorOffsetY = this.getBubbleAnchorOffsetY();
    this.bubbleContainer = this.scene.add.container(0, bubbleAnchorOffsetY);
    this.bubbleBg = this.scene.add.graphics();
    this.bubbleText = this.scene.add
      .text(0, 0, "", {
        fontSize: `${this.displayMetrics.bubbleFontSize}px`,
        color: "#222222",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
        fontStyle: "bold",
        wordWrap: { width: this.displayMetrics.bubbleWrapWidth, useAdvancedWrap: true },
        resolution: 2,
      })
      .setOrigin(0.5, 1);

    this.bubbleContainer.add([this.bubbleBg, this.bubbleText]);
    this.bubbleContainer.setVisible(false);

    this.osBubbleContainer = this.scene.add.container(0, bubbleAnchorOffsetY);
    this.osBubbleBg = this.scene.add.graphics();
    this.osBubbleText = this.scene.add
      .text(0, 0, "", {
        fontSize: `${this.displayMetrics.bubbleFontSize * 0.9}px`,
        color: "#444444",
        fontFamily: "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
        fontStyle: "italic",
        wordWrap: { width: this.displayMetrics.bubbleWrapWidth, useAdvancedWrap: true },
        resolution: 2,
      })
      .setOrigin(0.5, 1);
    this.osBubbleContainer.add([this.osBubbleBg, this.osBubbleText]);
    this.osBubbleContainer.setVisible(false);
    this.updateOsBubblePosition();

    this.createDomLabel();

    this.add([
      this.shadow,
      this.bodyContainer,
      this.bubbleContainer,
      this.osBubbleContainer,
    ]);

    this.syncOverlayZoom(this.scene.cameras.main.zoom);
  }

  private createDomLabel(): void {
    const overlayRoot =
      document.getElementById("label-root") ?? document.getElementById("ui-root");
    if (!overlayRoot) return;

    const root = document.createElement("div");
    root.className = "character-label";

    const nameRow = document.createElement("div");
    nameRow.className = "character-label__name-row";

    const name = document.createElement("div");
    name.className = "character-label__name";
    name.textContent = this.characterName;

    const icon = document.createElement("span");
    icon.className = "character-label__icon";
    icon.style.display = "none";

    nameRow.append(name, icon);
    root.append(nameRow);
    overlayRoot.appendChild(root);

    this.labelRoot = root;
    this.mbtiEl = null;
    this.nameRowEl = nameRow;
    this.nameEl = name;
    this.actionIconEl = icon;
    this.updateDomLabelStyle();
    this.updateDomLabelVisibility();
    this.updateDomLabelPosition();
  }

  private createCircleBody(color: number): void {
    const strokeWidth = this.displayMetrics.circleStrokeWidth;
    this.bodyCircle = this.scene.add
      .circle(0, 0, this.displayMetrics.circleRadius, color)
      .setStrokeStyle(strokeWidth, 0xffffff, 1);

    const highlight = this.scene.add.arc(
      this.displayMetrics.circleHighlightOffsetX,
      this.displayMetrics.circleHighlightOffsetY,
      this.displayMetrics.circleHighlightRadius,
      0,
      360,
      false,
      0xffffff,
      0.35,
    );
    this.bodyContainer = this.scene.add.container(0, 0, [this.bodyCircle, highlight]);

    this.idleTween = this.scene.tweens.add({
      targets: this.bodyContainer,
      scaleY: 0.94,
      scaleX: 1.04,
      y: 4,
      duration: 800 + Math.random() * 400,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  private createSpriteBody(): void {
    this.bodySprite = this.scene.add.sprite(0, 0, this.characterId, 18);
    this.bodySprite.setDisplaySize(this.displayMetrics.spriteWidth, this.displayMetrics.spriteHeight);
    this.bodySprite.setOrigin(0.5, 0.85);

    this.bodyContainer = this.scene.add.container(0, 0, [this.bodySprite]);

    const prefix = `${this.characterId}_`;
    const anims = this.scene.anims;
    if (!anims.exists(prefix + "walk-left")) {
      anims.create({
        key: prefix + "walk-left",
        frames: anims.generateFrameNumbers(this.characterId, { start: 0, end: 5 }),
        frameRate: SPRITE_WALK_FRAME_RATE,
        repeat: -1,
      });
    }
    if (!anims.exists(prefix + "walk-down")) {
      anims.create({
        key: prefix + "walk-down",
        frames: anims.generateFrameNumbers(this.characterId, { start: 6, end: 11 }),
        frameRate: SPRITE_WALK_FRAME_RATE,
        repeat: -1,
      });
    }
    if (!anims.exists(prefix + "walk-up")) {
      anims.create({
        key: prefix + "walk-up",
        frames: anims.generateFrameNumbers(this.characterId, { start: 12, end: 17 }),
        frameRate: SPRITE_WALK_FRAME_RATE,
        repeat: -1,
      });
    }

    this.setIdleFrame("down");
  }

  private setIdleFrame(direction: FacingDirection): void {
    if (!this.bodySprite) return;
    this.bodySprite.stop();
    switch (direction) {
      case "down":
        this.bodySprite.flipX = false;
        this.bodySprite.setFrame(18);
        break;
      case "up":
        this.bodySprite.flipX = false;
        this.bodySprite.setFrame(19);
        break;
      case "left":
        this.bodySprite.flipX = false;
        this.bodySprite.setFrame(20);
        break;
      case "right":
        this.bodySprite.flipX = true;
        this.bodySprite.setFrame(20);
        break;
    }
  }

  private playWalkAnim(direction: FacingDirection): void {
    if (!this.bodySprite) return;
    const prefix = `${this.characterId}_`;
    let animKey: string;
    let flipX = false;

    switch (direction) {
      case "left":
        animKey = prefix + "walk-left";
        break;
      case "right":
        animKey = prefix + "walk-left";
        flipX = true;
        break;
      case "up":
        animKey = prefix + "walk-up";
        break;
      case "down":
      default:
        animKey = prefix + "walk-down";
        break;
    }

    this.bodySprite.flipX = flipX;
    const currentKey = this.bodySprite.anims?.currentAnim?.key;
    if (currentKey !== animKey || !this.bodySprite.anims.isPlaying) {
      this.bodySprite.play(animKey, true);
    }
  }

  private getDirectionTo(targetX: number, targetY: number): FacingDirection {
    const dx = targetX - this.x;
    const dy = targetY - this.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      return dx < 0 ? "left" : "right";
    }
    return dy < 0 ? "up" : "down";
  }

  walkAlongPath(path: { x: number; y: number }[], onComplete?: () => void): void {
    if (this.isMoving) this.stopMoving();
    this.isMoving = true;
    this.startWalkingAnimation();
    let index = 0;

    const walkNext = () => {
      if (index >= path.length) {
        this.isMoving = false;
        this.moveTween = null;
        this.stopWalkingAnimation();
        onComplete?.();
        return;
      }
      const target = path[index];
      const dist = Phaser.Math.Distance.Between(this.x, this.y, target.x, target.y);
      const speed = this.getWalkSpeed();
      const duration = Math.max(50, (dist / speed) * 1000);

      if (this.hasSprite) {
        this.facing = this.getDirectionTo(target.x, target.y);
        this.playWalkAnim(this.facing);
      }

      this.moveTween = this.scene.tweens.add({
        targets: this,
        x: target.x,
        y: target.y,
        duration,
        ease: "Linear",
        onComplete: () => {
          index++;
          walkNext();
        },
      });
    };
    walkNext();
  }

  stopMoving(): void {
    if (this.moveTween) {
      this.moveTween.stop();
      this.moveTween = null;
    }
    this.isMoving = false;
    this.stopWalkingAnimation();
  }

  setCurrentAction(action: string | null): void {
    this.currentAction = action;
  }

  setMovementAnchor(anchor: MovementAnchor | null): void {
    this.movementAnchor = anchor ? { ...anchor } : null;
  }

  faceTowards(otherX: number, otherY: number): void {
    this.facing = this.getDirectionTo(otherX, otherY);
    this.setIdleFrame(this.facing);
  }

  canAmbientWander(): boolean {
    return !this.isMoving && (!this.currentAction || this.currentAction === "idle" || this.currentAction === "post_dialogue");
  }

  getSortFootY(): number {
    return this.y + (this.hasSprite ? this.displayMetrics.sortFootYOffset : this.displayMetrics.circleRadius * 0.65);
  }

  getWorldBodyHeight(): number {
    if (this.hasSprite) {
      return this.bodySprite?.displayHeight ?? this.displayMetrics.spriteHeight;
    }
    return (this.bodyCircle?.radius ?? this.displayMetrics.circleRadius) * 2;
  }

  showBubble(
    text: string,
    duration = 3000,
    textStyleOverrides: Partial<Phaser.Types.GameObjects.Text.TextStyle> = {},
  ): void {
    if (this.bubbleHideTimer) {
      this.bubbleHideTimer.remove(false);
      this.bubbleHideTimer = null;
    }
    this.applyBubbleTextStyle({
      fontStyle: "bold",
      color: "#222222",
      ...textStyleOverrides,
    });
    this.bubbleText.setText(text);
    this.bubbleText.updateText();
    const textW = this.bubbleText.width;
    const textH = this.bubbleText.height;
    const pad = this.displayMetrics.bubblePadding;
    const tailH = this.displayMetrics.bubbleTailHeight;
    const w = textW + pad * 2;
    const h = textH + pad * 2;
    const shadowOffset = Math.max(1, pad * 0.22);
    this.currentBubbleVerticalSpan = h + tailH;

    this.bubbleBg.clear();
    this.bubbleBg.fillStyle(0x000000, 0.12);
    this.bubbleBg.fillRoundedRect(
      -w / 2 + shadowOffset,
      -h - tailH + shadowOffset,
      w,
      h,
      this.displayMetrics.bubbleCornerRadius,
    );
    this.bubbleBg.fillStyle(0xffffff, 1);
    this.bubbleBg.fillRoundedRect(
      -w / 2,
      -h - tailH,
      w,
      h,
      this.displayMetrics.bubbleCornerRadius,
    );
    this.bubbleBg.fillTriangle(-tailH, -tailH - 1, tailH, -tailH - 1, 0, 0);

    this.bubbleText.setY(-tailH - pad);

    this.bubbleContainer.setVisible(true);
    this.updateDomLabelVisibility();
    this.updateOsBubblePosition();
    this.bubbleHideTimer = this.scene.time.delayedCall(duration, () => {
      this.bubbleContainer.setVisible(false);
      this.currentBubbleVerticalSpan = 0;
      this.updateDomLabelVisibility();
      this.updateOsBubblePosition();
      this.bubbleHideTimer = null;
    });
  }

  showMonologue(text: string): void {
    if (this.osBubbleHideTimer) {
      this.osBubbleHideTimer.remove(false);
      this.osBubbleHideTimer = null;
    }
    const duration = 7000;
    this.osBubbleText.setText(text);
    this.osBubbleText.updateText();
    const textW = this.osBubbleText.width;
    const textH = this.osBubbleText.height;
    const pad = this.displayMetrics.bubblePadding;
    const tailH = this.displayMetrics.bubbleTailHeight + 4;
    const w = textW + pad * 2;
    const h = textH + pad * 2;
    const shadowOffset = Math.max(1, pad * 0.22);

    this.osBubbleBg.clear();
    
    const cr = this.displayMetrics.bubbleCornerRadius * 1.8;
    
    this.osBubbleBg.fillStyle(0x000000, 0.12);
    this.osBubbleBg.fillRoundedRect(-w / 2 + shadowOffset, -h - tailH + shadowOffset, w, h, cr);
    this.osBubbleBg.fillStyle(0xffffff, 0.95);
    this.osBubbleBg.fillRoundedRect(-w / 2, -h - tailH, w, h, cr);
    
    this.osBubbleBg.fillCircle(4, -tailH + 2, 4.5);
    this.osBubbleBg.fillCircle(-2, -tailH + 11, 3);
    this.osBubbleBg.fillCircle(2, -tailH + 18, 2);

    this.osBubbleText.setY(-tailH - pad);

    this.updateOsBubblePosition();
    this.osBubbleContainer.setVisible(true);
    this.updateDomLabelVisibility();
    this.osBubbleHideTimer = this.scene.time.delayedCall(duration, () => {
      this.osBubbleContainer.setVisible(false);
      this.updateDomLabelVisibility();
      this.osBubbleHideTimer = null;
    });
  }

  setActionIcon(emoji: string): void {
    if (!this.actionIconEl) return;
    this.actionIconEl.textContent = emoji;
    this.actionIconEl.style.display = emoji ? "inline-block" : "none";
  }

  clearTransientUi(): void {
    if (this.bubbleHideTimer) {
      this.bubbleHideTimer.remove(false);
      this.bubbleHideTimer = null;
    }
    if (this.osBubbleHideTimer) {
      this.osBubbleHideTimer.remove(false);
      this.osBubbleHideTimer = null;
    }
    this.bubbleContainer.setVisible(false);
    this.osBubbleContainer.setVisible(false);
    this.currentBubbleVerticalSpan = 0;
    this.updateDomLabelVisibility();
    this.updateOsBubblePosition();
  }

  syncOverlayZoom(cameraZoom: number): void {
    const safeZoom = Math.max(cameraZoom, 0.01);
    if (Math.abs(this.overlayZoom - safeZoom) >= 0.001) {
      this.overlayZoom = safeZoom;
    }

    this.updateDomLabelStyle();
    this.updateDomLabelPosition();
  }

  private updateDomLabelStyle(): void {
    if (!this.labelRoot || !this.nameRowEl || !this.nameEl || !this.actionIconEl) return;

    const zoom = Math.max(this.overlayZoom, 0.01);
    const nameSize = Phaser.Math.Clamp(this.displayMetrics.labelNameWorldSize * zoom, 10, 26);
    const iconSize = Phaser.Math.Clamp(this.displayMetrics.labelIconWorldSize * zoom, 10, 22);
    const gap = Phaser.Math.Clamp(this.displayMetrics.labelGapWorld * zoom, 1, 6);

    this.labelRoot.style.gap = `${gap}px`;
    this.nameRowEl.style.gap = `${Math.max(2, gap)}px`;
    this.nameEl.style.fontSize = `${nameSize}px`;
    this.actionIconEl.style.fontSize = `${iconSize}px`;
  }

  private updateDomLabelVisibility(): void {
    if (!this.labelRoot) return;
    const yieldToBubble = this.bubbleContainer?.visible || this.osBubbleContainer?.visible;
    this.labelRoot.style.visibility = yieldToBubble ? "hidden" : "visible";
  }

  private applyBubbleTextStyle(overrides: Phaser.Types.GameObjects.Text.TextStyle): void {
    this.bubbleText.setStyle({
      fontSize: `${this.displayMetrics.bubbleFontSize}px`,
      color: "#222222",
      fontFamily: "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
      fontStyle: "bold",
      wordWrap: { width: this.displayMetrics.bubbleWrapWidth, useAdvancedWrap: true },
      resolution: 2,
      ...overrides,
    });
  }

  private getBubbleAnchorOffsetY(): number {
    return this.hasSprite ? this.displayMetrics.bubbleOffsetY : -this.displayMetrics.circleRadius * 4.2;
  }

  private updateOsBubblePosition(): void {
    const baseY = this.getBubbleAnchorOffsetY();
    const stackedGap = Math.max(10, this.displayMetrics.bubblePadding * 0.75);
    const nextY = this.bubbleContainer.visible
      ? baseY - this.currentBubbleVerticalSpan - stackedGap
      : baseY;
    this.osBubbleContainer.setY(nextY);
  }

  private updateDomLabelPosition(): void {
    if (!this.labelRoot) return;

    const camera = this.scene.cameras.main;
    const worldView = camera.worldView;
    const screenX = (this.x - worldView.x) * camera.zoom + camera.x;
    const screenY = (this.y - worldView.y) * camera.zoom + camera.y;
    const visible =
      this.active &&
      this.visible &&
      screenX >= -120 &&
      screenX <= camera.width + 120 &&
      screenY >= -120 &&
      screenY <= camera.height + 120;

    this.labelRoot.style.display = visible ? "flex" : "none";
    this.updateDomLabelVisibility();
    if (!visible) return;

    // screenY is the container origin = roughly the character's feet.
    // Compute where the head actually is on screen by using the real
    // sprite geometry, so the label tracks perfectly at any zoom level.
    const headScreenY = screenY - this.getHeadWorldOffset() * camera.zoom;
    this.labelRoot.style.left = `${Math.round(screenX)}px`;
    this.labelRoot.style.top = `${Math.round(headScreenY)}px`;
  }

  /** World-unit distance from the container origin (feet) up to the head top. */
  private getHeadWorldOffset(): number {
    if (this.hasSprite) {
      const h =
        this.bodySprite?.displayHeight ??
        this.displayMetrics.spriteWidth * (SPRITE_FRAME_HEIGHT / SPRITE_FRAME_WIDTH);
      const originY = this.bodySprite?.originY ?? 0.85;
      // originY portion is above the anchor; shave ~15% for transparent padding
      return h * originY * 0.85;
    }
    return (this.bodyCircle?.radius ?? this.displayMetrics.circleRadius) + this.displayMetrics.circleRadius * 0.1;
  }

  private getWalkSpeed(): number {
    return Math.max(48, this.getWorldBodyHeight() * WALK_SPEED_BODY_HEIGHT_RATIO);
  }

  private startWalkingAnimation(): void {
    if (this.hasSprite) return;
    if (this.walkTween) return;
    this.idleTween?.pause();
    this.walkTween = this.scene.tweens.add({
      targets: this.bodyContainer,
      y: 8,
      scaleX: 1.1,
      scaleY: 0.9,
      duration: 160,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  private stopWalkingAnimation(): void {
    if (this.hasSprite) {
      this.setIdleFrame(this.facing);
      return;
    }
    if (this.walkTween) {
      this.walkTween.stop();
      this.walkTween = null;
    }
    this.bodyContainer.setY(0);
    this.bodyContainer.setScale(1, 1);
    this.idleTween?.resume();
  }

  enableClick(callback: (charId: string) => void): void {
    this.on("pointerdown", () => callback(this.characterId));
    this.on("pointerover", () => {
      if (this.bodyCircle) {
        this.bodyCircle.setStrokeStyle(this.displayMetrics.circleStrokeWidth, 0xffff00);
      } else if (this.bodySprite) {
        this.bodySprite.setTint(0xddddff);
      }
    });
    this.on("pointerout", () => {
      if (this.bodyCircle) {
        this.bodyCircle.setStrokeStyle(this.displayMetrics.circleStrokeWidth, 0xffffff, 1);
      } else if (this.bodySprite) {
        this.bodySprite.clearTint();
      }
    });
  }

  override destroy(fromScene?: boolean): void {
    this.bubbleHideTimer?.remove(false);
    this.bubbleHideTimer = null;
    this.osBubbleHideTimer?.remove(false);
    this.osBubbleHideTimer = null;
    this.labelRoot?.remove();
    this.labelRoot = null;
    this.mbtiEl = null;
    this.nameRowEl = null;
    this.nameEl = null;
    this.actionIconEl = null;
    super.destroy(fromScene);
  }
}
