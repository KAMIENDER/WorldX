import Phaser from "phaser";
import { apiClient } from "../ui/services/api-client";
import type { GameTime, SimulationEvent, WorldTimeInfo } from "../types/api";

type TickResponse = {
  ok: boolean;
  gameTime: WorldTimeInfo;
  eventCount: number;
  events: SimulationEvent[];
};

export class PlaybackController extends Phaser.Events.EventEmitter {
  private currentTime: WorldTimeInfo = {
    day: 1,
    tick: 0,
    timeString: "08:00",
    period: "上午",
  };
  private autoPlay = false;
  private tickIntervalMs = 0;
  private nextTickDueAt = 0;
  private tickStartedAt = 0;
  private playbackInProgress = false;
  private requestInFlight = false;
  private prefetchedTick: TickResponse | null = null;

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
    if (!this.autoPlay || this.playbackInProgress) return;
    if (performance.now() < this.nextTickDueAt) return;
    if (this.requestInFlight && !this.prefetchedTick) return;
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
    if (this.playbackInProgress) return;
    if (this.requestInFlight && !this.prefetchedTick) return;

    this.playbackInProgress = true;
    this.tickStartedAt = performance.now();
    this.globalEventBus.emit("simulation_status", {
      status: "running",
      autoPlay: this.autoPlay,
      tickIntervalMs: this.tickIntervalMs,
    });

    try {
      const result = this.prefetchedTick ?? await this.fetchTick();
      this.prefetchedTick = null;
      this.currentTime = result.gameTime;

      this.globalEventBus.emit("tick_playback_started", {
        gameTime: result.gameTime,
        eventCount: result.events?.length ?? 0,
      });
      for (const event of result.events || []) {
        this.emit("event", event);
      }
      this.globalEventBus.emit("time_update", { ...this.currentTime });
      this.globalEventBus.emit("tick_playback_events_flushed", {
        gameTime: result.gameTime,
        eventCount: result.events?.length ?? 0,
      });

      if (this.autoPlay) {
        this.ensurePrefetch();
      }

      await this.waitForTickPlaybackCompletion(result.events?.length ?? 0);
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
      this.playbackInProgress = false;
      if (this.autoPlay) {
        this.nextTickDueAt = this.tickStartedAt + this.tickIntervalMs;
      } else {
        this.nextTickDueAt = 0;
      }
    }
  }

  private async fetchTick(): Promise<TickResponse> {
    this.requestInFlight = true;
    try {
      return await apiClient.simulateTick();
    } finally {
      this.requestInFlight = false;
    }
  }

  private ensurePrefetch(): void {
    if (!this.autoPlay || this.prefetchedTick || this.requestInFlight) return;
    void this.fetchTick()
      .then((result) => {
        this.prefetchedTick = result;
      })
      .catch((error) => {
        this.autoPlay = false;
        this.emitPlaybackState();
        console.warn("[PlaybackController] Failed to prefetch tick:", error);
        this.globalEventBus.emit("simulation_status", {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          autoPlay: this.autoPlay,
          tickIntervalMs: this.tickIntervalMs,
        });
      });
  }

  private waitForTickPlaybackCompletion(eventCount: number): Promise<void> {
    if (eventCount <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.globalEventBus.once("tick_playback_complete", () => resolve());
    });
  }

  private emitPlaybackState(): void {
    this.globalEventBus.emit("playback_state", {
      autoPlay: this.autoPlay,
      tickIntervalMs: this.tickIntervalMs,
    });
  }
}
