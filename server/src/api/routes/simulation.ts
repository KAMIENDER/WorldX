import { Router } from "express";
import { appContext } from "../../services/app-context.js";
import {
  buildWorldTimeInfo,
  getBatchTicksForOneCycle,
} from "../../utils/time-helpers.js";
import * as eventStore from "../../store/event-store.js";
import {
  getRecentTickRuns,
  getTickTraceDetail,
} from "../../store/tick-trace-store.js";
import { enrichEventTime } from "./events.js";

const router = Router();

type SimStatus = "idle" | "running" | "paused";

let simStatus: SimStatus = "idle";
let simProgress = { current: 0, total: 0 };
let cancelRequested = false;
let tickQueue: Promise<void> = Promise.resolve();
let queuedTickCount = 0;
const DEFAULT_PREFETCH_TICKS = 2;
const MAX_CONFIGURED_PREFETCH_TICKS = 10;

class TickQueueFullError extends Error {
  constructor(readonly maxQueuedTicks: number) {
    super(`Tick queue is full. maxQueuedTicks=${maxQueuedTicks}`);
    this.name = "TickQueueFullError";
  }
}

function getConfiguredPrefetchTicks(): number {
  const raw = process.env.SIMULATION_PREFETCH_TICKS;
  if (raw != null && raw.trim() !== "") {
    return clampInt(Number(raw), 0, MAX_CONFIGURED_PREFETCH_TICKS, DEFAULT_PREFETCH_TICKS);
  }

  const legacyQueueLimit = Number(process.env.SIMULATION_MAX_TICK_QUEUE);
  if (Number.isFinite(legacyQueueLimit) && legacyQueueLimit > 0) {
    return clampInt(Math.floor(legacyQueueLimit) - 1, 0, MAX_CONFIGURED_PREFETCH_TICKS, DEFAULT_PREFETCH_TICKS);
  }

  return DEFAULT_PREFETCH_TICKS;
}

function getMaxQueuedTicks(): number {
  const raw = Number(process.env.SIMULATION_MAX_TICK_QUEUE);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return Math.max(1, getConfiguredPrefetchTicks() + 1);
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

async function runSingleTick(streamId?: string): Promise<{
  ok: boolean;
  gameTime: ReturnType<typeof buildWorldTimeInfo>;
  eventCount: number;
  events: ReturnType<typeof enrichEventTime>[];
}> {
  simStatus = "running";
  const events = await appContext.simulationEngine.simulateTick({ streamId });
  const gameTime = appContext.worldManager.getCurrentTime();
  const worldTime = buildWorldTimeInfo(gameTime);
  const persistedEvents = eventStore
    .getEventsByIds(events.map((event) => event.id))
    .map(enrichEventTime);

  appContext.eventBus.emit("tick_events", { gameTime, events });
  appContext.eventBus.emit("simulation_status", { status: "idle" });

  simStatus = "idle";
  return {
    ok: true,
    gameTime: worldTime,
    eventCount: events.length,
    events: persistedEvents,
  };
}

function enqueueTick(streamId?: string): Promise<Awaited<ReturnType<typeof runSingleTick>>> {
  const maxQueuedTicks = getMaxQueuedTicks();
  if (queuedTickCount >= maxQueuedTicks) {
    throw new TickQueueFullError(maxQueuedTicks);
  }

  queuedTickCount += 1;
  const job = tickQueue
    .catch(() => undefined)
    .then(() => runSingleTick(streamId))
    .finally(() => {
      queuedTickCount = Math.max(0, queuedTickCount - 1);
    });
  tickQueue = job.then(() => undefined, () => undefined);
  return job;
}

// GET /simulation/tick-traces — recent persisted timing traces
router.get("/tick-traces", (req, res) => {
  const rawLimit = Number(req.query.limit ?? 20);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 20;
  res.json({ traces: getRecentTickRuns(limit) });
});

// GET /simulation/config — runtime playback/backpressure settings
router.get("/config", (_req, res) => {
  res.json({
    prefetchTicks: getConfiguredPrefetchTicks(),
    maxQueuedTicks: getMaxQueuedTicks(),
  });
});

// GET /simulation/tick-traces/:id — timing phases + LLM calls for one tick
router.get("/tick-traces/:id", (req, res) => {
  const trace = getTickTraceDetail(req.params.id);
  if (!trace) {
    res.status(404).json({ error: "Tick trace not found" });
    return;
  }
  res.json({ trace });
});

// POST /simulation/tick — advance 1 tick
router.post("/tick", async (req, res) => {
  try {
    const streamId =
      typeof req.body?.streamId === "string" && req.body.streamId.trim()
        ? req.body.streamId.trim().slice(0, 80)
        : undefined;
    res.json(await enqueueTick(streamId));
  } catch (err) {
    simStatus = "idle";
    if (err instanceof TickQueueFullError) {
      res.status(429).json({
        error: err.message,
        maxQueuedTicks: err.maxQueuedTicks,
      });
      return;
    }
    res.status(500).json({ error: String(err) });
  }
});

// POST /simulation/day — simulate 1 full day
router.post("/day", async (_req, res) => {
  try {
    simStatus = "running";
    cancelRequested = false;
    const currentTime = appContext.worldManager.getCurrentTime();
    const sceneConfig = appContext.worldManager.getSceneConfig();
    const maxTicks = getBatchTicksForOneCycle({
      sceneType: sceneConfig.sceneType,
      startTime: sceneConfig.startTime,
      tickDurationMinutes: sceneConfig.tickDurationMinutes,
      maxTicks: sceneConfig.maxTicks,
      sceneDay: currentTime.day,
      displayFormat: sceneConfig.displayFormat,
      multiDay: sceneConfig.multiDay,
    });
    simProgress = { current: 0, total: maxTicks };

    appContext.eventBus.emit("simulation_status", {
      status: "running",
      progress: simProgress,
    });

    const allEvents: any[] = [];

    for (let i = 0; i < maxTicks; i++) {
      if (cancelRequested) {
        simStatus = "paused";
        appContext.eventBus.emit("simulation_status", { status: "paused" });
        res.json({
          ok: true,
          paused: true,
          gameTime: buildWorldTimeInfo(appContext.worldManager.getCurrentTime()),
          eventCount: allEvents.length,
          ticksCompleted: i,
        });
        return;
      }

      const events = await appContext.simulationEngine.simulateTick();
      allEvents.push(...events);
      simProgress.current = i + 1;

      const gameTime = appContext.worldManager.getCurrentTime();
      appContext.eventBus.emit("tick_events", { gameTime, events });
    }

    simStatus = "idle";
    appContext.eventBus.emit("simulation_status", { status: "idle" });

    res.json({
      ok: true,
      gameTime: buildWorldTimeInfo(appContext.worldManager.getCurrentTime()),
      eventCount: allEvents.length,
    });
  } catch (err) {
    simStatus = "idle";
    res.status(500).json({ error: String(err) });
  }
});

// POST /simulation/days — simulate N days
router.post("/days", async (req, res) => {
  const count = req.body?.count ?? 1;
  if (typeof count !== "number" || count < 1 || count > 100) {
    res.status(400).json({ error: "count must be 1-100" });
    return;
  }

  try {
    simStatus = "running";
    cancelRequested = false;
    const currentTime = appContext.worldManager.getCurrentTime();
    const sceneConfig = appContext.worldManager.getSceneConfig();
    const maxTicks = getBatchTicksForOneCycle({
      sceneType: sceneConfig.sceneType,
      startTime: sceneConfig.startTime,
      tickDurationMinutes: sceneConfig.tickDurationMinutes,
      maxTicks: sceneConfig.maxTicks,
      sceneDay: currentTime.day,
      displayFormat: sceneConfig.displayFormat,
      multiDay: sceneConfig.multiDay,
    });
    const totalTicks = count * maxTicks;
    simProgress = { current: 0, total: totalTicks };

    appContext.eventBus.emit("simulation_status", {
      status: "running",
      progress: simProgress,
    });

    let totalEvents = 0;

    for (let d = 0; d < count; d++) {
      for (let t = 0; t < maxTicks; t++) {
        if (cancelRequested) {
          simStatus = "paused";
          appContext.eventBus.emit("simulation_status", { status: "paused" });
          res.json({
            ok: true,
            paused: true,
            gameTime: buildWorldTimeInfo(appContext.worldManager.getCurrentTime()),
            eventCount: totalEvents,
            ticksCompleted: simProgress.current,
          });
          return;
        }

        const events = await appContext.simulationEngine.simulateTick();
        totalEvents += events.length;
        simProgress.current = d * maxTicks + t + 1;

        const gameTime = appContext.worldManager.getCurrentTime();
        appContext.eventBus.emit("tick_events", { gameTime, events });
      }
    }

    simStatus = "idle";
    appContext.eventBus.emit("simulation_status", { status: "idle" });

    res.json({
      ok: true,
      gameTime: buildWorldTimeInfo(appContext.worldManager.getCurrentTime()),
      eventCount: totalEvents,
    });
  } catch (err) {
    simStatus = "idle";
    res.status(500).json({ error: String(err) });
  }
});

// POST /simulation/pause
router.post("/pause", (_req, res) => {
  cancelRequested = true;
  res.json({ ok: true });
});

// POST /simulation/resume
router.post("/resume", (_req, res) => {
  cancelRequested = false;
  if (simStatus === "paused") simStatus = "idle";
  res.json({ ok: true });
});

// POST /simulation/reset
router.post("/reset", (_req, res) => {
  try {
    appContext.resetWorldState();
    const gameTime = buildWorldTimeInfo(appContext.worldManager.getCurrentTime());
    simStatus = "idle";
    res.json({ ok: true, gameTime });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /simulation/status
router.get("/status", (_req, res) => {
  const gameTime = buildWorldTimeInfo(appContext.worldManager.getCurrentTime());
  res.json({
    status: simStatus,
    gameTime,
    progress: simStatus === "running" ? simProgress : null,
  });
});

export default router;
