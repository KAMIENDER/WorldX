import { AsyncLocalStorage } from "node:async_hooks";
import { getDb } from "./db.js";
import type { GameTime } from "../types/index.js";
import { generateId } from "../utils/id-generator.js";

export interface TickTraceContext {
  runId: string;
  streamId?: string;
  startedAtMs: number;
  lastMarkerAtMs: number;
  sequence: number;
}

export interface StartTickRunInput {
  streamId?: string;
  timelineId?: string | null;
  gameTime: GameTime;
  metadata?: Record<string, unknown>;
}

export interface TickRunSummary {
  id: string;
  streamId?: string;
  timelineId?: string;
  gameDay: number;
  gameTick: number;
  startedAt: string;
  criticalEndedAt?: string;
  endedAt?: string;
  criticalPathMs: number;
  totalMs: number;
  status: string;
  eventCount: number;
  error?: string;
  metadata: Record<string, unknown>;
  phaseCount: number;
  llmCallCount: number;
  llmDurationMs: number;
}

export interface TickPhaseTimingInfo {
  id: string;
  tickRunId: string;
  sequence: number;
  phase: string;
  label?: string;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  durationMs: number;
  metadata: Record<string, unknown>;
}

export interface TickTraceDetail extends TickRunSummary {
  phases: TickPhaseTimingInfo[];
  llmCalls: Array<{
    id: string;
    taskType: string;
    characterId?: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    cost: number;
    durationMs: number;
    success: boolean;
    error?: string;
    createdAt: string;
  }>;
}

const storage = new AsyncLocalStorage<TickTraceContext>();

export function startTickRun(input: StartTickRunInput): TickTraceContext {
  const now = Date.now();
  const runId = generateId();
  const metadata = input.metadata ?? {};
  getDb()
    .prepare(
      `INSERT INTO tick_runs
       (id, stream_id, timeline_id, game_day, game_tick, started_at, status, metadata)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
    )
    .run(
      runId,
      input.streamId ?? null,
      input.timelineId ?? null,
      input.gameTime.day,
      input.gameTime.tick,
      new Date(now).toISOString(),
      JSON.stringify(metadata),
    );
  return {
    runId,
    streamId: input.streamId,
    startedAtMs: now,
    lastMarkerAtMs: now,
    sequence: 0,
  };
}

export function runWithTickTrace<T>(
  context: TickTraceContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}

export function getCurrentTickRunId(): string | undefined {
  return storage.getStore()?.runId;
}

export function getCurrentTickTraceContext(): TickTraceContext | undefined {
  return storage.getStore();
}

export function recordTickPhase(
  phase: string,
  label: string,
  metadata: Record<string, unknown> = {},
): void {
  const context = storage.getStore();
  if (!context) return;

  const now = Date.now();
  const startedAtMs = context.lastMarkerAtMs;
  const sequence = context.sequence;
  context.lastMarkerAtMs = now;
  context.sequence += 1;

  getDb()
    .prepare(
      `INSERT INTO tick_phase_timings
       (id, tick_run_id, sequence, phase, label, started_at, ended_at, elapsed_ms, duration_ms, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      generateId(),
      context.runId,
      sequence,
      phase,
      label,
      new Date(startedAtMs).toISOString(),
      new Date(now).toISOString(),
      Math.max(0, now - context.startedAtMs),
      Math.max(0, now - startedAtMs),
      JSON.stringify(metadata),
    );
}

export function finishTickRunCritical(
  runId: string,
  input: {
    eventCount: number;
    hasBackgroundWork: boolean;
  },
): void {
  const context = storage.getStore();
  const now = Date.now();
  const startedAtMs = context?.runId === runId ? context.startedAtMs : undefined;
  const criticalPathMs = startedAtMs ? Math.max(0, now - startedAtMs) : 0;
  const status = input.hasBackgroundWork ? "sync_complete" : "complete";
  const endedAtSql = input.hasBackgroundWork ? "" : ", ended_at = @endedAt, total_ms = @criticalPathMs";
  getDb()
    .prepare(
      `UPDATE tick_runs
       SET critical_ended_at = @endedAt,
           critical_path_ms = @criticalPathMs,
           status = @status,
           event_count = @eventCount
           ${endedAtSql}
       WHERE id = @runId`,
    )
    .run({
      runId,
      endedAt: new Date(now).toISOString(),
      criticalPathMs,
      status,
      eventCount: input.eventCount,
    });
}

export function finishTickRunBackground(
  runId: string,
  input: {
    status?: "complete" | "background_failed";
    error?: string;
  } = {},
): void {
  const context = storage.getStore();
  const now = Date.now();
  const startedAtMs = context?.runId === runId ? context.startedAtMs : undefined;
  const totalMs = startedAtMs ? Math.max(0, now - startedAtMs) : 0;
  getDb()
    .prepare(
      `UPDATE tick_runs
       SET ended_at = ?,
           total_ms = CASE WHEN ? > 0 THEN ? ELSE total_ms END,
           status = ?,
           error = COALESCE(?, error)
       WHERE id = ?`,
    )
    .run(
      new Date(now).toISOString(),
      totalMs,
      totalMs,
      input.status ?? "complete",
      input.error ?? null,
      runId,
    );
}

export function failTickRun(
  runId: string,
  input: {
    eventCount: number;
    error: string;
  },
): void {
  const context = storage.getStore();
  const now = Date.now();
  const startedAtMs = context?.runId === runId ? context.startedAtMs : undefined;
  const totalMs = startedAtMs ? Math.max(0, now - startedAtMs) : 0;
  getDb()
    .prepare(
      `UPDATE tick_runs
       SET critical_ended_at = ?,
           ended_at = ?,
           critical_path_ms = ?,
           total_ms = ?,
           status = 'failed',
           event_count = ?,
           error = ?
       WHERE id = ?`,
    )
    .run(
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      totalMs,
      totalMs,
      input.eventCount,
      input.error,
      runId,
    );
}

export function getRecentTickRuns(limit = 20): TickRunSummary[] {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = getDb()
    .prepare(
      `SELECT
         tr.*,
         (SELECT COUNT(*) FROM tick_phase_timings WHERE tick_run_id = tr.id) AS phase_count,
         (SELECT COUNT(*) FROM llm_call_logs WHERE tick_run_id = tr.id) AS llm_call_count,
         COALESCE((SELECT SUM(duration_ms) FROM llm_call_logs WHERE tick_run_id = tr.id), 0) AS llm_duration_ms
       FROM tick_runs tr
       ORDER BY tr.started_at DESC
       LIMIT ?`,
    )
    .all(safeLimit) as any[];
  return rows.map(rowToTickRunSummary);
}

export function getTickTraceDetail(runId: string): TickTraceDetail | null {
  const row = getDb()
    .prepare(
      `SELECT
         tr.*,
         (SELECT COUNT(*) FROM tick_phase_timings WHERE tick_run_id = tr.id) AS phase_count,
         (SELECT COUNT(*) FROM llm_call_logs WHERE tick_run_id = tr.id) AS llm_call_count,
         COALESCE((SELECT SUM(duration_ms) FROM llm_call_logs WHERE tick_run_id = tr.id), 0) AS llm_duration_ms
       FROM tick_runs tr
       WHERE tr.id = ?`,
    )
    .get(runId) as any | undefined;
  if (!row) return null;

  const phases = getDb()
    .prepare(
      `SELECT * FROM tick_phase_timings WHERE tick_run_id = ? ORDER BY sequence ASC`,
    )
    .all(runId) as any[];
  const llmCalls = getDb()
    .prepare(
      `SELECT * FROM llm_call_logs WHERE tick_run_id = ? ORDER BY created_at ASC`,
    )
    .all(runId) as any[];

  return {
    ...rowToTickRunSummary(row),
    phases: phases.map(rowToTickPhaseTiming),
    llmCalls: llmCalls.map(rowToLlmCall),
  };
}

function rowToTickRunSummary(row: any): TickRunSummary {
  return {
    id: row.id,
    streamId: row.stream_id ?? undefined,
    timelineId: row.timeline_id ?? undefined,
    gameDay: row.game_day,
    gameTick: row.game_tick,
    startedAt: row.started_at,
    criticalEndedAt: row.critical_ended_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    criticalPathMs: row.critical_path_ms ?? 0,
    totalMs: row.total_ms ?? 0,
    status: row.status,
    eventCount: row.event_count ?? 0,
    error: row.error ?? undefined,
    metadata: parseJsonObject(row.metadata),
    phaseCount: row.phase_count ?? 0,
    llmCallCount: row.llm_call_count ?? 0,
    llmDurationMs: row.llm_duration_ms ?? 0,
  };
}

function rowToTickPhaseTiming(row: any): TickPhaseTimingInfo {
  return {
    id: row.id,
    tickRunId: row.tick_run_id,
    sequence: row.sequence,
    phase: row.phase,
    label: row.label ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    elapsedMs: row.elapsed_ms ?? 0,
    durationMs: row.duration_ms ?? 0,
    metadata: parseJsonObject(row.metadata),
  };
}

function rowToLlmCall(row: any): TickTraceDetail["llmCalls"][number] {
  return {
    id: row.id,
    taskType: row.task_type,
    characterId: row.character_id ?? undefined,
    model: row.model,
    promptTokens: row.prompt_tokens ?? 0,
    completionTokens: row.completion_tokens ?? 0,
    cost: row.cost ?? 0,
    durationMs: row.duration_ms ?? 0,
    success: row.success === 1,
    error: row.error ?? undefined,
    createdAt: row.created_at,
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
