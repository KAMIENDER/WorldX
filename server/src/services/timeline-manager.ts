import fs from "node:fs";
import path from "node:path";
import type { GameTime, SimulationEvent } from "../types/index.js";
import { listAllWorlds } from "../utils/world-directories.js";
import { getDb } from "../store/db.js";

export type TimelineSaveKind = "run" | "manual";

export interface TimelineMeta {
  id: string;
  worldId: string;
  name?: string;
  note?: string;
  summary?: string;
  saveKind?: TimelineSaveKind;
  sourceTimelineId?: string;
  worldSnapshotDir?: string;
  snapshotVersion?: number;
  createdAt: string;
  updatedAt: string;
  lastGameTime: GameTime;
  tickCount: number;
  status: "recording" | "stopped";
}

export interface InitFrameCharacter {
  id: string;
  name: string;
  location: string;
  mainAreaPointId: string | null;
}

export interface TimelineInitFrame {
  type: "init";
  gameTime: GameTime;
  characters: InitFrameCharacter[];
}

export interface TimelineTickFrame {
  type: "tick";
  gameTime: GameTime;
  events: any[];
}

export type TimelineFrame = TimelineInitFrame | TimelineTickFrame;

const TIMELINES_DIR_NAME = "timelines";
const WORLD_SNAPSHOT_DIR_NAME = "world-snapshot";
const SNAPSHOT_VERSION = 1;

function generateTimelineId(prefix = "tl"): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${prefix}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function sanitizeSaveText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized.slice(0, maxLength) : undefined;
}

function copyFileIfExists(source: string, target: string): boolean {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

function copyDirectoryIfExists(source: string, target: string): boolean {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) return false;
  fs.cpSync(source, target, { recursive: true, force: true });
  return true;
}

function copyJsonFilesIfExists(source: string, target: string): boolean {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) return false;
  const jsonFiles = fs.readdirSync(source).filter((file) => file.endsWith(".json"));
  if (jsonFiles.length === 0) return false;
  fs.mkdirSync(target, { recursive: true });
  for (const file of jsonFiles) {
    copyFileIfExists(path.join(source, file), path.join(target, file));
  }
  return true;
}

export class TimelineManager {
  private worldDir: string | null = null;
  private currentTimelineId: string | null = null;
  private eventStream: fs.WriteStream | null = null;
  private tickCount = 0;

  /**
   * Resolve (or create) a timeline for the given world directory.
   * If timelineId is provided and exists, use it; otherwise pick the latest or create new.
   * Returns the resolved timeline ID.
   */
  initialize(worldDir: string, timelineId?: string): string {
    this.worldDir = worldDir;

    if (timelineId) {
      const dir = this.getTimelineDir(worldDir, timelineId);
      if (fs.existsSync(dir) && fs.existsSync(path.join(dir, "meta.json"))) {
        this.currentTimelineId = timelineId;
        this.tickCount = this.readMeta(worldDir, timelineId).tickCount;
        return timelineId;
      }
    }

    const timelines = this.listTimelines(worldDir);
    if (timelines.length > 0) {
      const latest = timelines[0];
      this.currentTimelineId = latest.id;
      this.tickCount = latest.tickCount;
      return latest.id;
    }

    return this.createTimeline(worldDir);
  }

  createTimeline(worldDir: string): string {
    const id = this.allocateTimelineId(worldDir, "tl");
    const dir = this.getTimelineDir(worldDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const worldSnapshotDir = this.copyWorldSnapshot(worldDir, dir);

    const worldId = path.basename(worldDir);
    const meta: TimelineMeta = {
      id,
      worldId,
      saveKind: "run",
      worldSnapshotDir,
      snapshotVersion: SNAPSHOT_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastGameTime: { day: 1, tick: 0 },
      tickCount: 0,
      status: "recording",
    };
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

    this.worldDir = worldDir;
    this.currentTimelineId = id;
    this.tickCount = 0;
    return id;
  }

  async createManualSaveFromCurrent(
    worldDir: string,
    input: { name?: unknown; note?: unknown } = {},
  ): Promise<TimelineMeta> {
    if (!this.currentTimelineId) {
      throw new Error("No active timeline to save");
    }

    const sourceTimelineId = this.currentTimelineId;
    const sourceMeta = this.readMeta(worldDir, sourceTimelineId);
    const id = this.allocateTimelineId(worldDir, "sv");
    const dir = this.getTimelineDir(worldDir, id);
    fs.mkdirSync(dir, { recursive: true });

    const worldSnapshotDir = this.copyWorldSnapshot(worldDir, dir);
    await getDb().backup(this.getTimelineDbPath(worldDir, id));

    const sourceEventsPath = this.getTimelineEventsPath(worldDir, sourceTimelineId);
    if (fs.existsSync(sourceEventsPath)) {
      copyFileIfExists(sourceEventsPath, this.getTimelineEventsPath(worldDir, id));
    }

    const createdAt = new Date().toISOString();
    const displayName =
      sanitizeSaveText(input.name, 80) ??
      `手动存档 D${sourceMeta.lastGameTime.day} · ${sourceMeta.tickCount}t`;
    const note = sanitizeSaveText(input.note, 240);
    const summary =
      note ??
      `第 ${sourceMeta.lastGameTime.day} 天，已推进 ${sourceMeta.tickCount} 步。`;
    const meta: TimelineMeta = {
      ...sourceMeta,
      id,
      worldId: path.basename(worldDir),
      name: displayName,
      note,
      summary,
      saveKind: "manual",
      sourceTimelineId,
      worldSnapshotDir,
      snapshotVersion: SNAPSHOT_VERSION,
      createdAt,
      updatedAt: createdAt,
      status: "stopped",
    };
    this.writeMeta(worldDir, id, meta);
    return meta;
  }

  startRecording(characters: InitFrameCharacter[]): void {
    if (!this.worldDir || !this.currentTimelineId) return;

    const eventsPath = this.getCurrentEventsPath();
    if (!eventsPath) return;

    const isNewFile = !fs.existsSync(eventsPath) || fs.statSync(eventsPath).size === 0;

    this.eventStream = fs.createWriteStream(eventsPath, { flags: "a" });

    if (isNewFile) {
      const initFrame: TimelineInitFrame = {
        type: "init",
        gameTime: { day: 1, tick: 0 },
        characters,
      };
      this.eventStream.write(JSON.stringify(initFrame) + "\n");
    }

    this.updateMetaField({ status: "recording" });
  }

  appendTickEvents(gameTime: GameTime, events: SimulationEvent[]): void {
    if (!this.eventStream || !this.worldDir || !this.currentTimelineId) return;

    const frame: TimelineTickFrame = {
      type: "tick",
      gameTime,
      events: events.map((e) => ({
        ...e,
        data: typeof e.data === "string" ? JSON.parse(e.data) : e.data,
        tags: typeof e.tags === "string" ? JSON.parse(e.tags as any) : e.tags,
      })),
    };

    this.eventStream.write(JSON.stringify(frame) + "\n");

    this.tickCount++;
    this.updateMetaField({
      lastGameTime: gameTime,
      tickCount: this.tickCount,
      updatedAt: new Date().toISOString(),
    });
  }

  stopRecording(): void {
    if (this.eventStream) {
      this.eventStream.end();
      this.eventStream = null;
    }
    this.updateMetaField({ status: "stopped" });
  }

  listTimelines(worldDir: string): TimelineMeta[] {
    const timelinesDir = path.join(worldDir, TIMELINES_DIR_NAME);
    if (!fs.existsSync(timelinesDir)) return [];

    return fs.readdirSync(timelinesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          return this.readMeta(worldDir, entry.name);
        } catch {
          return null;
        }
      })
      .filter((m): m is TimelineMeta => m !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listAllTimelinesGrouped(): {
    worldId: string;
    worldName: string;
    source: string;
    isCurrent: boolean;
    timelines: TimelineMeta[];
  }[] {
    const worlds = listAllWorlds();
    const currentWorldId = this.worldDir ? path.basename(this.worldDir) : null;

    return worlds.map((world) => ({
      worldId: world.id,
      worldName: world.worldName,
      source: world.source,
      isCurrent: world.id === currentWorldId,
      timelines: this.listTimelines(world.dir),
    }));
  }

  deleteTimeline(worldDir: string, timelineId: string): void {
    const dir = this.getTimelineDir(worldDir, timelineId);
    if (!fs.existsSync(dir)) return;

    if (this.currentTimelineId === timelineId && this.worldDir === worldDir) {
      this.stopRecording();
      this.currentTimelineId = null;
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }

  getTimelineDir(worldDir: string, timelineId: string): string {
    return path.join(worldDir, TIMELINES_DIR_NAME, timelineId);
  }

  getTimelineDbPath(worldDir: string, timelineId: string): string {
    return path.join(this.getTimelineDir(worldDir, timelineId), "state.db");
  }

  getTimelineEventsPath(worldDir: string, timelineId: string): string {
    return path.join(this.getTimelineDir(worldDir, timelineId), "events.jsonl");
  }

  getTimelineConfigSnapshotDir(worldDir: string, timelineId: string): string | null {
    const meta = this.readMeta(worldDir, timelineId);
    if (!meta.worldSnapshotDir) return null;
    const snapshotDir = path.join(this.getTimelineDir(worldDir, timelineId), meta.worldSnapshotDir);
    return fs.existsSync(snapshotDir) ? snapshotDir : null;
  }

  getCurrentTimelineId(): string | null {
    return this.currentTimelineId;
  }

  getCurrentWorldDir(): string | null {
    return this.worldDir;
  }

  getTickCount(): number {
    return this.tickCount;
  }

  readTimelineEvents(worldDir: string, timelineId: string): TimelineFrame[] {
    const eventsPath = this.getTimelineEventsPath(worldDir, timelineId);
    if (!fs.existsSync(eventsPath)) return [];

    const content = fs.readFileSync(eventsPath, "utf-8").trim();
    if (!content) return [];

    return content.split("\n").map((line) => JSON.parse(line) as TimelineFrame);
  }

  private getCurrentEventsPath(): string | null {
    if (!this.worldDir || !this.currentTimelineId) return null;
    return this.getTimelineEventsPath(this.worldDir, this.currentTimelineId);
  }

  private readMeta(worldDir: string, timelineId: string): TimelineMeta {
    const metaPath = path.join(
      this.getTimelineDir(worldDir, timelineId),
      "meta.json",
    );
    return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as TimelineMeta;
  }

  private writeMeta(worldDir: string, timelineId: string, meta: TimelineMeta): void {
    const metaPath = path.join(
      this.getTimelineDir(worldDir, timelineId),
      "meta.json",
    );
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  private updateMetaField(patch: Partial<TimelineMeta>): void {
    if (!this.worldDir || !this.currentTimelineId) return;

    const dir = this.getTimelineDir(this.worldDir, this.currentTimelineId);
    const metaPath = path.join(dir, "meta.json");
    if (!fs.existsSync(metaPath)) return;

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as TimelineMeta;
      Object.assign(meta, patch);
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch {
      // Non-critical; best-effort update
    }
  }

  private allocateTimelineId(worldDir: string, prefix: string): string {
    const base = generateTimelineId(prefix);
    let id = base;
    let suffix = 2;
    while (fs.existsSync(this.getTimelineDir(worldDir, id))) {
      id = `${base}-${suffix}`;
      suffix++;
    }
    return id;
  }

  private copyWorldSnapshot(worldDir: string, timelineDir: string): string | undefined {
    const snapshotDir = path.join(timelineDir, WORLD_SNAPSHOT_DIR_NAME);
    let copied = false;

    copied = copyDirectoryIfExists(
      path.join(worldDir, "config"),
      path.join(snapshotDir, "config"),
    ) || copied;
    copied = copyFileIfExists(
      path.join(worldDir, "world.json"),
      path.join(snapshotDir, "world.json"),
    ) || copied;
    copied = copyFileIfExists(
      path.join(worldDir, "scene.json"),
      path.join(snapshotDir, "scene.json"),
    ) || copied;
    copied = copyJsonFilesIfExists(
      path.join(worldDir, "characters"),
      path.join(snapshotDir, "characters"),
    ) || copied;

    const mapDir = path.join(worldDir, "map");
    const snapshotMapDir = path.join(snapshotDir, "map");
    copied = copyFileIfExists(
      path.join(mapDir, "06-final.tmj"),
      path.join(snapshotMapDir, "06-final.tmj"),
    ) || copied;
    if (fs.existsSync(mapDir) && fs.statSync(mapDir).isDirectory()) {
      for (const file of fs.readdirSync(mapDir)) {
        if (!file.endsWith(".json")) continue;
        copied = copyFileIfExists(path.join(mapDir, file), path.join(snapshotMapDir, file)) || copied;
      }
    }

    return copied ? WORLD_SNAPSHOT_DIR_NAME : undefined;
  }
}
