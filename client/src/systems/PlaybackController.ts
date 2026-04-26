import Phaser from "phaser";
import { apiClient, type TickProgressInfo } from "../ui/services/api-client";
import type {
  GameTime,
  SimulationEvent,
  WorldTimeInfo,
  TimelineFrame,
  TimelineTickFrame,
} from "../types/api";

type TickResponse = {
  ok: boolean;
  gameTime: WorldTimeInfo;
  eventCount: number;
  events: SimulationEvent[];
  streamId: string;
};

export type PlaybackMode = "live" | "replay";

const DEFAULT_LIVE_TICK_ESTIMATE_MS = 4000;
const MIN_LIVE_TICK_ESTIMATE_MS = 1200;
const MAX_LIVE_TICK_ESTIMATE_MS = 20000;
const RECENT_TICK_DURATION_SAMPLE_SIZE = 3;
const STREAM_EVENT_SPACING_MS = 420;
const DEFAULT_LIVE_PREFETCH_TICKS = 2;
const MAX_LIVE_PREFETCH_TICKS = 10;

type TickStreamState = {
  streamId: string;
  bufferedEvents: SimulationEvent[];
  knownEventIds: Set<string>;
  emittedEventIds: Set<string>;
  started: boolean;
  draining: boolean;
  complete: boolean;
};

type LiveTickSlot = {
  streamId: string;
  promise: Promise<TickResponse>;
  result?: TickResponse;
  error?: unknown;
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
  private maxLivePrefetchTicks = DEFAULT_LIVE_PREFETCH_TICKS;
  private liveTickSlots: LiveTickSlot[] = [];
  private recentTickRequestDurations: number[] = [];
  private tickStreams: Map<string, TickStreamState> = new Map();
  private activePlaybackStreamId: string | null = null;
  private cycleTicks = 48;
  private curtainDropped = false;

  private mode: PlaybackMode = "live";
  private replayFrames: TimelineFrame[] = [];
  private replayIndex = 0;
  private replayAutoPlay = false;
  private replayNextDueAt = 0;
  private replayTickStartedAt = 0;

  constructor(private globalEventBus: Phaser.Events.EventEmitter) {
    super();
    this.globalEventBus.on("tick_progress", this.handleTickProgress);
  }

  async initialize(): Promise<void> {
    const [worldTime, simulationConfig] = await Promise.all([
      apiClient.getWorldTime(),
      apiClient.getSimulationConfig().catch((error) => {
        console.warn("[PlaybackController] Failed to load simulation config:", error);
        return null;
      }),
    ]);
    if (simulationConfig) {
      this.maxLivePrefetchTicks = Phaser.Math.Clamp(
        Math.floor(simulationConfig.prefetchTicks),
        0,
        MAX_LIVE_PREFETCH_TICKS,
      );
    }
    this.currentTime = worldTime;
    this.globalEventBus.emit("time_update", { ...this.currentTime });
    this.globalEventBus.emit("simulation_status", { status: "idle" });
    this.emitPlaybackState();
  }

  getCurrentTime(): WorldTimeInfo {
    return { ...this.currentTime };
  }

  getMode(): PlaybackMode {
    return this.mode;
  }

  setCycleTicks(n: number): void {
    this.cycleTicks = n;
  }

  // --- Replay mode ---

  async startReplay(timelineId: string): Promise<void> {
    if (this.mode === "replay") return;

    this.autoPlay = false;
    this.liveTickSlots = [];

    try {
      const { frames } = await apiClient.getTimelineEvents(timelineId);
      if (frames.length === 0) {
        console.warn("[PlaybackController] No events to replay");
        return;
      }

      this.mode = "replay";
      this.replayFrames = frames;
      this.replayIndex = 0;
      this.replayAutoPlay = false;

      const initFrame = frames[0];
      if (initFrame.type === "init") {
        this.globalEventBus.emit("replay_init", initFrame);
        this.replayIndex = 1;
      }

      const totalTicks = frames.filter((f) => f.type === "tick").length;
      this.globalEventBus.emit("set_replay_mode", { active: true });
      this.globalEventBus.emit("replay_progress", {
        current: 0,
        total: totalTicks,
      });
      this.emitPlaybackState();
    } catch (err) {
      console.error("[PlaybackController] Failed to start replay:", err);
      this.globalEventBus.emit("simulation_status", {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  stopReplay(): void {
    if (this.mode !== "replay") return;

    this.mode = "live";
    this.replayFrames = [];
    this.replayIndex = 0;
    this.replayAutoPlay = false;
    this.playbackInProgress = false;

    this.globalEventBus.emit("set_replay_mode", { active: false });
    this.globalEventBus.emit("replay_ended");
    this.globalEventBus.emit("simulation_status", { status: "idle" });
    this.emitPlaybackState();
  }

  setReplayAutoPlay(enabled: boolean): void {
    this.replayAutoPlay = enabled;
    this.replayNextDueAt = enabled ? performance.now() : 0;
    this.emitPlaybackState();
  }

  // --- Main update loop ---

  update(_delta: number): void {
    if (this.mode === "replay") {
      this.updateReplay();
      return;
    }

    if (!this.autoPlay || this.playbackInProgress) return;
    if (performance.now() < this.nextTickDueAt) return;
    void this.devAdvanceTick();
  }

  private updateReplay(): void {
    if (!this.replayAutoPlay || this.playbackInProgress) return;
    if (performance.now() < this.replayNextDueAt) return;
    void this.advanceReplayTick();
  }

  private async advanceReplayTick(): Promise<void> {
    if (this.replayIndex >= this.replayFrames.length) {
      this.replayAutoPlay = false;
      this.globalEventBus.emit("replay_finished");
      this.emitPlaybackState();
      return;
    }

    this.playbackInProgress = true;
    this.replayTickStartedAt = performance.now();

    const frame = this.replayFrames[this.replayIndex];
    this.replayIndex++;

    if (frame.type !== "tick") {
      this.playbackInProgress = false;
      return;
    }

    const tickFrame = frame as TimelineTickFrame;
    const events = tickFrame.events ?? [];

    this.currentTime = {
      ...this.currentTime,
      day: tickFrame.gameTime.day,
      tick: tickFrame.gameTime.tick,
    };

    this.globalEventBus.emit("tick_playback_started", {
      gameTime: tickFrame.gameTime,
      eventCount: events.length,
    });

    for (const event of events) {
      this.emit("event", event);
    }

    this.globalEventBus.emit("time_update", { ...this.currentTime });
    this.globalEventBus.emit("tick_playback_events_flushed", {
      gameTime: tickFrame.gameTime,
      eventCount: events.length,
    });

    const ticksPlayed = this.replayFrames
      .slice(0, this.replayIndex)
      .filter((f) => f.type === "tick").length;
    const totalTicks = this.replayFrames.filter((f) => f.type === "tick").length;
    this.globalEventBus.emit("replay_progress", {
      current: ticksPlayed,
      total: totalTicks,
    });

    try {
      await this.waitForTickPlaybackCompletion(events.length);
    } catch {
      // continue
    }

    this.playbackInProgress = false;

    if (this.replayAutoPlay) {
      this.replayNextDueAt = this.replayTickStartedAt + this.tickIntervalMs;
    }

    if (this.replayIndex >= this.replayFrames.length) {
      this.replayAutoPlay = false;
      this.globalEventBus.emit("replay_finished");
      this.emitPlaybackState();
    }
  }

  // --- Live mode ---

  async seekTo(time: GameTime): Promise<void> {
    this.currentTime = {
      ...this.currentTime,
      ...time,
    };
    this.globalEventBus.emit("time_update", { ...this.currentTime });
  }

  pause(): void {
    if (this.mode === "replay") {
      this.setReplayAutoPlay(false);
      return;
    }
    this.setAutoPlay(false);
    this.globalEventBus.emit("simulation_status", { status: "paused" });
  }

  resume(): void {
    if (this.mode === "replay") {
      this.setReplayAutoPlay(true);
      return;
    }
    this.setAutoPlay(true);
    this.globalEventBus.emit("simulation_status", { status: "idle" });
  }

  setAutoPlay(enabled: boolean): void {
    if (this.mode === "replay") return;
    this.autoPlay = enabled;
    this.nextTickDueAt = enabled ? performance.now() : 0;
    this.emitPlaybackState();
  }

  setTickIntervalMs(value: number): void {
    this.tickIntervalMs = value;
    if (this.mode === "replay") {
      this.emitPlaybackState();
      return;
    }
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
    if (this.mode === "replay") return;
    if (this.playbackInProgress) return;

    const isTransitioning = this.currentTime.tick === this.cycleTicks - 1;
    if (isTransitioning && !this.curtainDropped) {
      this.curtainDropped = true;
      this.playbackInProgress = true;
      await new Promise<void>((resolve) => {
        this.globalEventBus.emit("scene_ending", { day: this.currentTime.day });
        this.globalEventBus.once("scene_covered", () => resolve());
        setTimeout(resolve, 2000); // safety fallback
      });
      this.playbackInProgress = false;
    }

    this.playbackInProgress = true;
    this.curtainDropped = false;
    this.tickStartedAt = performance.now();
    this.globalEventBus.emit("simulation_status", {
      status: "running",
      autoPlay: this.autoPlay,
      tickIntervalMs: this.tickIntervalMs,
    });

    try {
      const playbackWindowMs = this.getLiveEventPlaybackWindowMs();
      this.ensureLivePrefetch(this.autoPlay ? this.getMaxLiveTickSlots() : 1);
      const activeSlot = this.liveTickSlots[0] ?? this.startTickRequest();
      this.activateStreamPlayback(activeSlot.streamId, playbackWindowMs);
      const result = await this.consumeNextLiveTick();
      this.activateStreamPlayback(result.streamId, playbackWindowMs);
      if (this.autoPlay) {
        this.ensureLivePrefetch(this.getMaxLiveTickSlots());
      }
      this.currentTime = result.gameTime;
      this.globalEventBus.emit("time_update", { ...this.currentTime });
      this.bufferFinalTickEvents(result);
      await this.waitForStreamDrain(result.streamId);
      this.globalEventBus.emit("tick_playback_events_flushed", {
        gameTime: result.gameTime,
        eventCount: result.events?.length ?? 0,
      });

      await this.waitForTickPlaybackCompletion(result.events?.length ?? 0);

      if (this.autoPlay) {
        this.ensureLivePrefetch(this.getMaxLiveTickSlots());
      }

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
      const finishedStreamId = this.activePlaybackStreamId;
      this.activePlaybackStreamId = null;
      if (finishedStreamId) {
        setTimeout(() => {
          this.tickStreams.delete(finishedStreamId);
        }, 5000);
      }
      this.playbackInProgress = false;
      if (this.autoPlay) {
        this.nextTickDueAt = Math.max(performance.now(), this.tickStartedAt + this.tickIntervalMs);
      } else {
        this.nextTickDueAt = 0;
      }
    }
  }

  private startTickRequest(): LiveTickSlot {
    const startedAt = performance.now();
    const streamId = `tick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.getOrCreateStream(streamId);
    const slot: LiveTickSlot = {
      streamId,
      promise: Promise.resolve(null as unknown as TickResponse),
    };
    slot.promise = apiClient.simulateTick({ streamId })
      .then((result) => {
        const tick = { ...result, streamId };
        slot.result = tick;
        return tick;
      })
      .catch((error) => {
        slot.error = error;
        throw error;
      })
      .finally(() => {
        this.recordTickRequestDuration(performance.now() - startedAt);
        const state = this.tickStreams.get(streamId);
        if (state) state.complete = true;
      });
    this.liveTickSlots.push(slot);
    return slot;
  }

  private ensureLivePrefetch(targetCount: number): void {
    if (this.mode !== "live") return;
    const count = Math.max(0, Math.min(this.getMaxLiveTickSlots(), Math.floor(targetCount)));
    while (this.liveTickSlots.length < count) {
      this.startTickRequest();
    }
  }

  private getMaxLiveTickSlots(): number {
    return Math.max(1, this.maxLivePrefetchTicks + 1);
  }

  private async consumeNextLiveTick(): Promise<TickResponse> {
    const slot = this.liveTickSlots[0] ?? this.startTickRequest();
    try {
      return slot.result ?? await slot.promise;
    } finally {
      const index = this.liveTickSlots.indexOf(slot);
      if (index >= 0) {
        this.liveTickSlots.splice(index, 1);
      }
    }
  }

  private recordTickRequestDuration(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    this.recentTickRequestDurations.push(durationMs);
    if (this.recentTickRequestDurations.length > RECENT_TICK_DURATION_SAMPLE_SIZE) {
      this.recentTickRequestDurations.shift();
    }
  }

  private getLiveEventPlaybackWindowMs(): number {
    if (!this.autoPlay || this.recentTickRequestDurations.length === 0) {
      return MIN_LIVE_TICK_ESTIMATE_MS;
    }
    const total = this.recentTickRequestDurations.reduce((sum, duration) => sum + duration, 0);
    const average = total / this.recentTickRequestDurations.length;
    return Phaser.Math.Clamp(
      average || DEFAULT_LIVE_TICK_ESTIMATE_MS,
      MIN_LIVE_TICK_ESTIMATE_MS,
      MAX_LIVE_TICK_ESTIMATE_MS,
    );
  }

  private handleTickProgress = (progress: TickProgressInfo): void => {
    if (this.mode !== "live" || !progress.streamId) return;
    const state = this.getOrCreateStream(progress.streamId);
    if (progress.phase === "tick_persisted") {
      state.complete = true;
    }
    this.addEventsToStream(state, progress.events ?? []);
    if (this.activePlaybackStreamId === progress.streamId) {
      this.activateStreamPlayback(progress.streamId, this.getLiveEventPlaybackWindowMs());
      this.drainActiveStreamBuffer(progress.streamId);
    }
  };

  private getOrCreateStream(streamId: string): TickStreamState {
    let state = this.tickStreams.get(streamId);
    if (!state) {
      state = {
        streamId,
        bufferedEvents: [],
        knownEventIds: new Set(),
        emittedEventIds: new Set(),
        started: false,
        draining: false,
        complete: false,
      };
      this.tickStreams.set(streamId, state);
    }
    return state;
  }

  private activateStreamPlayback(streamId: string, estimatedDurationMs: number): void {
    const state = this.getOrCreateStream(streamId);
    this.activePlaybackStreamId = streamId;
    if (!state.started) {
      state.started = true;
      this.globalEventBus.emit("tick_playback_started", {
        gameTime: this.currentTime,
        eventCount: 0,
        estimatedDurationMs,
        streaming: true,
      });
    }
    this.drainActiveStreamBuffer(streamId);
  }

  private bufferFinalTickEvents(result: TickResponse): void {
    const state = this.getOrCreateStream(result.streamId);
    state.complete = true;
    this.addEventsToStream(state, result.events || []);
    this.drainActiveStreamBuffer(result.streamId);
  }

  private addEventsToStream(state: TickStreamState, events: SimulationEvent[]): void {
    for (const event of events) {
      if (!event?.id || state.knownEventIds.has(event.id)) continue;
      state.knownEventIds.add(event.id);
      state.bufferedEvents.push(event);
    }
  }

  private drainActiveStreamBuffer(streamId: string): void {
    const state = this.tickStreams.get(streamId);
    if (!state || state.draining) return;
    state.draining = true;
    void (async () => {
      try {
        while (this.activePlaybackStreamId === streamId && state.bufferedEvents.length > 0) {
          const event = state.bufferedEvents.shift();
          if (event && !state.emittedEventIds.has(event.id)) {
            state.emittedEventIds.add(event.id);
            this.emit("event", event);
          }
          if (state.bufferedEvents.length > 0) {
            await this.delay(STREAM_EVENT_SPACING_MS);
          }
        }
      } finally {
        state.draining = false;
        if (this.activePlaybackStreamId === streamId && state.bufferedEvents.length > 0) {
          this.drainActiveStreamBuffer(streamId);
        }
      }
    })();
  }

  private waitForStreamDrain(streamId: string): Promise<void> {
    this.drainActiveStreamBuffer(streamId);
    return new Promise((resolve) => {
      const check = () => {
        const state = this.tickStreams.get(streamId);
        if (!state || (!state.draining && state.bufferedEvents.length === 0)) {
          resolve();
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
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
      autoPlay: this.mode === "replay" ? this.replayAutoPlay : this.autoPlay,
      tickIntervalMs: this.tickIntervalMs,
      mode: this.mode,
    });
  }
}
