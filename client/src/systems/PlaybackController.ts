import Phaser from "phaser";
import { apiClient } from "../ui/services/api-client";
import type { GameTime, WorldTimeInfo } from "../types/api";

export class PlaybackController extends Phaser.Events.EventEmitter {
  private currentTime: WorldTimeInfo = {
    day: 1,
    tick: 0,
    timeString: "08:00",
    period: "上午",
  };
  private tickInFlight = false;
  private autoPlay = false;
  private tickIntervalMs = 0;
  private nextTickDueAt = 0;
  private tickStartedAt = 0;

  constructor(private globalEventBus: Phaser.Events.EventEmitter) {
    super();
  }

  async initialize(): Promise<void> {
    const worldTime = await apiClient.getWorldTime();
    this.currentTime = worldTime;
    this.globalEventBus.emit("time_update", { ...this.currentTime });
    this.globalEventBus.emit("simulation_status", { status: "idle" });
    this.emitPlaybackState();
  }

  getCurrentTime(): WorldTimeInfo {
    return { ...this.currentTime };
  }

  update(_delta: number): void {
    if (!this.autoPlay || this.tickInFlight) return;
    if (performance.now() < this.nextTickDueAt) return;
    void this.devAdvanceTick();
  }

  async seekTo(time: GameTime): Promise<void> {
    this.currentTime = {
      ...this.currentTime,
      ...time,
    };
    this.globalEventBus.emit("time_update", { ...this.currentTime });
  }

  pause(): void {
    this.setAutoPlay(false);
    this.globalEventBus.emit("simulation_status", { status: "paused" });
  }

  resume(): void {
    this.setAutoPlay(true);
    this.globalEventBus.emit("simulation_status", { status: "idle" });
  }

  setAutoPlay(enabled: boolean): void {
    this.autoPlay = enabled;
    this.nextTickDueAt = enabled ? performance.now() : 0;
    this.emitPlaybackState();
  }

  setTickIntervalMs(value: number): void {
    this.tickIntervalMs = value;
    if (!this.autoPlay) {
      this.nextTickDueAt = 0;
    } else if (this.tickStartedAt > 0) {
      this.nextTickDueAt = this.tickStartedAt + this.tickIntervalMs;
    } else {
      this.nextTickDueAt = performance.now();
    }
    this.emitPlaybackState();
  }

  async devAdvanceTick(): Promise<void> {
    if (this.tickInFlight) return;

    this.tickInFlight = true;
    this.tickStartedAt = performance.now();
    this.globalEventBus.emit("simulation_status", {
      status: "running",
      autoPlay: this.autoPlay,
      tickIntervalMs: this.tickIntervalMs,
    });

    try {
      const result = await apiClient.simulateTick();
      this.currentTime = result.gameTime;

      try {
        const events = await apiClient.getEventsByRange(this.currentTime, this.currentTime);
        for (const event of events) {
          this.emit("event", event);
        }
      } catch (e) {
        console.warn("[PlaybackController] Failed to fetch tick events:", e);
      }

      this.globalEventBus.emit("time_update", { ...this.currentTime });
      this.globalEventBus.emit("simulation_status", {
        status: "idle",
        eventCount: result.eventCount,
        autoPlay: this.autoPlay,
        tickIntervalMs: this.tickIntervalMs,
      });
    } catch (e) {
      this.autoPlay = false;
      this.emitPlaybackState();
      console.warn("[PlaybackController] Failed to simulate tick:", e);
      this.globalEventBus.emit("simulation_status", {
        status: "error",
        message: e instanceof Error ? e.message : String(e),
        autoPlay: this.autoPlay,
        tickIntervalMs: this.tickIntervalMs,
      });
    } finally {
      this.tickInFlight = false;
      if (this.autoPlay) {
        this.nextTickDueAt = this.tickStartedAt + this.tickIntervalMs;
      }
    }
  }

  private emitPlaybackState(): void {
    this.globalEventBus.emit("playback_state", {
      autoPlay: this.autoPlay,
      tickIntervalMs: this.tickIntervalMs,
    });
  }
}
