import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import {
  apiClient,
  JobConflictError,
  type CreateJobEvent,
  type CreateJobPhase,
  type CreateJobSizeK,
  type CreateJobSnapshot,
} from "../services/api-client";
import { CreateWorldBackground } from "./CreateWorldBackground";

type Mode = "input" | "running" | "done" | "error";

interface PhaseInfo {
  phase: CreateJobPhase;
  title: string;
  hint: string;
}

const PHASES: PhaseInfo[] = [
  { phase: 1, title: "Designing world", hint: "LLM is dreaming up regions, characters and lore." },
  { phase: 2, title: "Painting the map", hint: "Image model paints the world; vision model annotates it." },
  { phase: 3, title: "Casting characters", hint: "Sprite sheets are generated and cleaned up." },
  { phase: 4, title: "Wiring simulation", hint: "Configs, navigation points and runtime are assembled." },
];

const PHASE_DESCRIPTIONS: Record<CreateJobPhase, string> = {
  1: "Designing world",
  2: "Painting the map",
  3: "Casting characters",
  4: "Wiring simulation",
};

const SIZE_OPTIONS: Array<{
  value: CreateJobSizeK;
  label: string;
  detail: string;
  estimate: string;
}> = [
  { value: 1, label: "1K", detail: "Quick draft", estimate: "~3–5 min" },
  { value: 2, label: "2K", detail: "Balanced (recommended)", estimate: "~6–10 min" },
  { value: 4, label: "4K", detail: "Cinematic detail", estimate: "~12–20 min" },
];

const PROMPT_EXAMPLES = [
  "宋朝繁华夜市，有算命先生、卖艺人、小偷、女侠、书生、酒鬼。",
  "A cozy mountain village in autumn, with a blacksmith, a tea house owner, a wandering monk and a curious child.",
  "未来都市的天台花园，有黑客、植物学家、退役机器人、流浪猫和一位失忆的诗人。",
];

export function CreateWorldPage({
  hasExistingWorlds,
}: {
  hasExistingWorlds: boolean;
}) {
  const [mode, setMode] = useState<Mode>("input");
  const [prompt, setPrompt] = useState("");
  const [sizeK, setSizeK] = useState<CreateJobSizeK>(2);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<CreateJobSnapshot | null>(null);
  const [events, setEvents] = useState<CreateJobEvent[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [conflictJobId, setConflictJobId] = useState<string | null>(null);
  const [cancelingJob, setCancelingJob] = useState(false);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  // On mount: if a job is already running, attach to it (covers refresh during generation).
  useEffect(() => {
    let cancelled = false;
    apiClient.getCurrentJob()
      .then((res) => {
        if (cancelled || !res.jobId || !res.snapshot) return;
        if (res.snapshot.status === "running") {
          setJobId(res.jobId);
          setSnapshot(res.snapshot);
          setPrompt(res.snapshot.prompt);
          setSizeK(res.snapshot.sizeK);
          setMode("running");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to job events when we have a jobId.
  useEffect(() => {
    if (!jobId) return;
    const unsubscribe = apiClient.subscribeJobEvents(jobId, (event) => {
      setEvents((prev) => {
        const next = prev.length >= 600 ? prev.slice(prev.length - 500) : prev;
        return [...next, event];
      });
      setSnapshot((prev) => applyEventToSnapshot(prev, event, jobId));
      if (event.kind === "job_done") {
        setCancelingJob(false);
        setMode("done");
      } else if (event.kind === "job_error") {
        setCancelingJob(false);
        setMode("error");
      }
    });
    return unsubscribe;
  }, [jobId]);

  // Auto-scroll log box.
  useEffect(() => {
    if (!logsOpen) return;
    const node = logBoxRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [events, logsOpen]);

  // On success, switch the world server-side and reload to land in the main UI.
  useEffect(() => {
    if (mode !== "done") return;
    if (!snapshot?.worldId) return;
    let cancelled = false;
    (async () => {
      try {
        await apiClient.switchWorld(snapshot.worldId!);
        if (cancelled) return;
        // Tiny delay to let the success animation register.
        setTimeout(() => {
          window.location.assign("/");
        }, 1200);
      } catch (err) {
        if (cancelled) return;
        console.warn("[CreateWorldPage] Failed to switch to new world:", err);
        setSubmitError(
          `World was generated but switching failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, snapshot?.worldId]);

  const onSubmit = useCallback(async () => {
    if (!prompt.trim()) {
      setSubmitError("Please describe the world you want to create.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setEvents([]);
    setSnapshot(null);
    try {
      const { jobId: id } = await apiClient.createWorld({ prompt: prompt.trim(), sizeK });
      setJobId(id);
      setCancelingJob(false);
      setMode("running");
    } catch (err) {
      if (err instanceof JobConflictError) {
        setConflictJobId(err.activeJobId);
        setSubmitError(
          "A world is already being generated. You can attach to the running job to follow its progress.",
        );
      } else {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }, [prompt, sizeK]);

  const onAttachToConflict = useCallback(() => {
    if (!conflictJobId) return;
    setEvents([]);
    setSnapshot(null);
    setSubmitError(null);
    setJobId(conflictJobId);
    setMode("running");
  }, [conflictJobId]);

  const onRetry = useCallback(() => {
    setMode("input");
    setEvents([]);
    setSnapshot(null);
    setJobId(null);
    setSubmitError(null);
    setConflictJobId(null);
    setCancelingJob(false);
  }, []);

  const onCancelJob = useCallback(async () => {
    if (!jobId || cancelingJob) return;
    setCancelingJob(true);
    try {
      await apiClient.cancelCreateWorld(jobId);
    } catch (err) {
      setCancelingJob(false);
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }, [jobId, cancelingJob]);

  const intensity = mode === "running" ? "active" : "calm";

  return (
    <div style={pageStyle}>
      <CreateWorldBackground intensity={intensity} />
      <div style={contentWrapStyle}>
        <header style={headerStyle}>
          <div style={brandStyle}>
            <span style={brandMarkStyle}>✦</span>
            <span style={brandNameStyle}>WorldSpark</span>
          </div>
          {hasExistingWorlds && mode === "input" && (
            <button onClick={() => window.location.assign("/")} style={ghostBtnStyle}>
              ← Back to current world
            </button>
          )}
        </header>

        {mode === "input" && (
          <InputView
            prompt={prompt}
            setPrompt={setPrompt}
            sizeK={sizeK}
            setSizeK={setSizeK}
            submitting={submitting}
            submitError={submitError}
            conflictJobId={conflictJobId}
            onSubmit={onSubmit}
            onAttachToConflict={onAttachToConflict}
          />
        )}

        {(mode === "running" || mode === "done" || mode === "error") && (
          <RunView
            mode={mode}
            snapshot={snapshot}
            events={events}
            logsOpen={logsOpen}
            setLogsOpen={setLogsOpen}
            logBoxRef={logBoxRef}
            sizeK={snapshot?.sizeK ?? sizeK}
            onRetry={onRetry}
            onCancelJob={onCancelJob}
            cancelingJob={cancelingJob}
          />
        )}
      </div>
    </div>
  );
}

function InputView({
  prompt,
  setPrompt,
  sizeK,
  setSizeK,
  submitting,
  submitError,
  conflictJobId,
  onSubmit,
  onAttachToConflict,
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  sizeK: CreateJobSizeK;
  setSizeK: (value: CreateJobSizeK) => void;
  submitting: boolean;
  submitError: string | null;
  conflictJobId: string | null;
  onSubmit: () => void;
  onAttachToConflict: () => void;
}) {
  return (
    <div style={cardStyle}>
      <h1 style={taglineStyle}>One sentence. One living world.</h1>
      <p style={subTaglineStyle}>
        Describe the world you want to live inside. WorldSpark will design the map,
        cast the characters, and bring everything to life.
      </p>

      <label style={labelStyle}>What kind of world?</label>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="A cozy mountain village in autumn, with a blacksmith, a tea house owner, a wandering monk and a curious child..."
        style={textareaStyle}
        rows={5}
        spellCheck={false}
      />
      <div style={examplesRowStyle}>
        <span style={examplesLabelStyle}>Try:</span>
        {PROMPT_EXAMPLES.map((example, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => setPrompt(example)}
            style={exampleChipStyle}
            title="Click to use this prompt"
          >
            {truncate(example, 32)}
          </button>
        ))}
      </div>

      <label style={{ ...labelStyle, marginTop: 24 }}>Map fidelity</label>
      <div style={sizeGridStyle}>
        {SIZE_OPTIONS.map((opt) => {
          const active = opt.value === sizeK;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setSizeK(opt.value)}
              style={sizeOptionStyle(active)}
            >
              <span style={sizeOptionTitleStyle(active)}>{opt.label}</span>
              <span style={sizeOptionDetailStyle}>{opt.detail}</span>
              <span style={sizeOptionEstimateStyle}>{opt.estimate}</span>
            </button>
          );
        })}
      </div>

      {submitError && (
        <div style={errorBoxStyle}>
          <div>{submitError}</div>
          {conflictJobId && (
            <button type="button" onClick={onAttachToConflict} style={attachBtnStyle}>
              Follow the running generation →
            </button>
          )}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 28 }}>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting || !prompt.trim()}
          style={primaryBtnStyle(submitting || !prompt.trim())}
        >
          {submitting ? "Starting..." : "✨ Create World"}
        </button>
      </div>
    </div>
  );
}

function RunView({
  mode,
  snapshot,
  events,
  logsOpen,
  setLogsOpen,
  logBoxRef,
  sizeK,
  onRetry,
  onCancelJob,
  cancelingJob,
}: {
  mode: Mode;
  snapshot: CreateJobSnapshot | null;
  events: CreateJobEvent[];
  logsOpen: boolean;
  setLogsOpen: (value: boolean) => void;
  logBoxRef: React.RefObject<HTMLDivElement | null>;
  sizeK: CreateJobSizeK;
  onRetry: () => void;
  onCancelJob: () => void;
  cancelingJob: boolean;
}) {
  const currentPhase = snapshot?.phase ?? 1;
  const currentLabel =
    mode === "done"
      ? "Your world is ready"
      : mode === "error"
      ? "Generation failed"
      : "Building your world...";

  const recentMilestones = useMemo(
    () =>
      events
        .filter((e) => e.kind === "phase" || e.kind === "step" || e.kind === "info")
        .slice(-6)
        .reverse(),
    [events],
  );

  const logLines = useMemo(
    () =>
      events.filter((e): e is Extract<CreateJobEvent, { kind: "log" }> => e.kind === "log"),
    [events],
  );

  const estimate = SIZE_OPTIONS.find((o) => o.value === sizeK)?.estimate ?? "";

  return (
    <div style={cardStyle}>
      <div style={runHeaderStyle}>
        <div>
          <div style={runEyebrowStyle}>
            {mode === "done"
              ? "Complete"
              : mode === "error"
              ? "Stopped"
              : `Generating · ${estimate}`}
          </div>
          <div style={runTitleStyle}>{currentLabel}</div>
          {snapshot?.prompt && (
            <div style={runPromptStyle}>“{truncate(snapshot.prompt, 160)}”</div>
          )}
        </div>
        {mode === "running" && (
          <div style={spinnerStyle} aria-hidden>
            <div style={spinnerDotStyle(0)} />
            <div style={spinnerDotStyle(1)} />
            <div style={spinnerDotStyle(2)} />
          </div>
        )}
        {mode === "done" && <div style={badgeDoneStyle}>✓</div>}
        {mode === "error" && <div style={badgeErrStyle}>!</div>}
      </div>

      <ol style={stepperStyle}>
        {PHASES.map((p) => {
          const isParallel = p.phase === 2 || p.phase === 3;
          const inParallel = currentPhase === 2 || currentPhase === 3;

          let status: "done" | "active" | "pending" | "error";
          if (mode === "done") {
            status = "done";
          } else if (mode === "error" && (currentPhase === p.phase || (isParallel && inParallel))) {
            status = "error";
          } else if (currentPhase > (isParallel ? 3 : p.phase)) {
            status = "done";
          } else if (isParallel && inParallel) {
            status = "active";
          } else if (currentPhase === p.phase) {
            status = "active";
          } else {
            status = "pending";
          }

          return (
            <li key={p.phase} style={stepperItemStyle}>
              <div style={stepperBulletStyle(status)}>
                {status === "done" ? "✓" : status === "error" ? "!" : p.phase}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={stepperTitleStyle(status)}>{p.title}</div>
                <div style={stepperHintStyle}>{p.hint}</div>
              </div>
            </li>
          );
        })}
      </ol>

      {recentMilestones.length > 0 && (
        <div style={milestonesStyle}>
          {recentMilestones.map((event, idx) => (
            <div
              key={`${event.at}-${idx}`}
              style={milestoneRowStyle(idx === 0)}
            >
              <span style={milestoneTimeStyle}>{formatTime(event.at)}</span>
              <span style={milestoneLabelStyle}>{describeEvent(event)}</span>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setLogsOpen(!logsOpen)}
        style={logsToggleStyle}
      >
        {logsOpen ? "Hide live logs" : "Show live logs"}{" "}
        <span style={{ opacity: 0.6, fontSize: 11 }}>({logLines.length})</span>
      </button>
      {logsOpen && (
        <div ref={logBoxRef} style={logsBoxStyle}>
          {logLines.length === 0 ? (
            <div style={{ opacity: 0.5 }}>(no log lines yet)</div>
          ) : (
            logLines.map((event, idx) => (
              <div
                key={idx}
                style={{
                  color: event.stream === "stderr" ? "#ffb0b0" : "#cfe9ff",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                }}
              >
                {event.line}
              </div>
            ))
          )}
        </div>
      )}

      {mode === "running" && (
        <div style={runFooterControlsStyle}>
          <button
            type="button"
            onClick={onCancelJob}
            disabled={cancelingJob}
            style={stopBtnStyle(cancelingJob)}
          >
            {cancelingJob ? "Stopping..." : "Stop"}
          </button>
        </div>
      )}

      {mode === "running" && (
        <div style={tipStyle}>
          You can leave this tab open or close it — generation runs on the server
          and resumes when you come back.
        </div>
      )}

      {mode === "done" && (
        <div style={{ ...tipStyle, color: "#a3f7bf" }}>
          Switching you into the new world…
        </div>
      )}

      {mode === "error" && snapshot?.error && (
        <div style={errorBoxStyle}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{snapshot.error}</div>
          {logLines.length > 0 && (
            <pre style={errorTailStyle}>
              {logLines.slice(-20).map((l) => l.line).join("\n")}
            </pre>
          )}
          <button type="button" onClick={onRetry} style={attachBtnStyle}>
            ← Try again
          </button>
        </div>
      )}
    </div>
  );
}

function applyEventToSnapshot(
  prev: CreateJobSnapshot | null,
  event: CreateJobEvent,
  jobId: string,
): CreateJobSnapshot {
  const base: CreateJobSnapshot =
    prev ?? {
      jobId,
      status: "running",
      prompt: "",
      sizeK: 2,
      phase: null,
      step: null,
      startedAt: Date.now(),
      finishedAt: null,
      worldId: null,
      worldName: null,
      error: null,
    };
  switch (event.kind) {
    case "job_started":
      return {
        ...base,
        prompt: event.prompt,
        sizeK: event.sizeK,
        startedAt: event.at,
        status: "running",
      };
    case "phase":
      return { ...base, phase: event.phase, step: null };
    case "step":
      return { ...base, phase: event.phase, step: event.label };
    case "world_id":
      return { ...base, worldId: event.worldId };
    case "job_done":
      return {
        ...base,
        status: "done",
        finishedAt: event.at,
        worldId: event.worldId || base.worldId,
        worldName: event.worldName ?? base.worldName,
      };
    case "job_error":
      return { ...base, status: "error", finishedAt: event.at, error: event.message };
    default:
      return base;
  }
}

function describeEvent(event: CreateJobEvent): string {
  switch (event.kind) {
    case "phase":
      return `Phase ${event.phase} · ${event.label}`;
    case "step":
      return `Phase ${event.phase} · ${event.label}`;
    case "info":
      return event.label;
    default:
      return "";
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max - 1)}…`;
}

// ─── Styles ────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "#070819",
  color: "#e8ecff",
  fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
  overflow: "auto",
  pointerEvents: "auto",
};

const contentWrapStyle: CSSProperties = {
  position: "relative",
  zIndex: 1,
  minHeight: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  padding: "32px 24px 48px",
  gap: 24,
};

const headerStyle: CSSProperties = {
  width: "100%",
  maxWidth: 880,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const brandStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
};

const brandMarkStyle: CSSProperties = {
  fontSize: 22,
  color: "#a3c2ff",
  textShadow: "0 0 14px rgba(116,185,255,0.6)",
};

const brandNameStyle: CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  letterSpacing: "0.04em",
};

const ghostBtnStyle: CSSProperties = {
  background: "transparent",
  color: "#a3b3da",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 999,
  padding: "8px 14px",
  fontSize: 12,
  cursor: "pointer",
};

const cardStyle: CSSProperties = {
  width: "100%",
  maxWidth: 720,
  background: "rgba(14, 18, 40, 0.78)",
  border: "1px solid rgba(255,255,255,0.08)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  borderRadius: 22,
  padding: "32px 32px 28px",
  boxShadow: "0 30px 80px rgba(0,0,0,0.45), 0 0 0 1px rgba(116,185,255,0.06) inset",
};

const taglineStyle: CSSProperties = {
  fontSize: 28,
  margin: 0,
  fontWeight: 700,
  letterSpacing: "0.01em",
  background: "linear-gradient(120deg, #ffffff 0%, #c5d6ff 60%, #f6c0ff 100%)",
  WebkitBackgroundClip: "text",
  WebkitTextFillColor: "transparent",
};

const subTaglineStyle: CSSProperties = {
  marginTop: 10,
  marginBottom: 28,
  fontSize: 14,
  color: "#a8b3d4",
  lineHeight: 1.6,
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "#9aa5cb",
  marginBottom: 8,
};

const textareaStyle: CSSProperties = {
  width: "100%",
  background: "rgba(8, 10, 24, 0.72)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 14,
  color: "#f3f6ff",
  padding: "14px 16px",
  fontSize: 15,
  lineHeight: 1.55,
  resize: "vertical",
  fontFamily: "inherit",
  outline: "none",
  transition: "border-color 0.2s, box-shadow 0.2s",
  boxShadow: "0 0 0 0 rgba(116,185,255,0)",
};

const examplesRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 8,
  marginTop: 10,
};

const examplesLabelStyle: CSSProperties = {
  fontSize: 11,
  color: "#7c87ad",
};

const exampleChipStyle: CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "#cfd6ee",
  borderRadius: 999,
  padding: "5px 11px",
  fontSize: 11,
  cursor: "pointer",
  transition: "all 0.15s",
};

const sizeGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 1fr)",
  gap: 12,
};

function sizeOptionStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 4,
    background: active
      ? "linear-gradient(135deg, rgba(116,185,255,0.22), rgba(180,134,255,0.18))"
      : "rgba(255,255,255,0.05)",
    border: `1px solid ${active ? "rgba(168,193,255,0.55)" : "rgba(255,255,255,0.1)"}`,
    color: "#e8ecff",
    borderRadius: 14,
    padding: "14px 16px",
    cursor: "pointer",
    textAlign: "left",
    transition: "all 0.2s",
    boxShadow: active ? "0 8px 24px rgba(116,185,255,0.18)" : "none",
  };
}

function sizeOptionTitleStyle(active: boolean): CSSProperties {
  return {
    fontSize: 18,
    fontWeight: 700,
    color: active ? "#ffffff" : "#dde4ff",
  };
}

const sizeOptionDetailStyle: CSSProperties = {
  fontSize: 12,
  color: "#a8b3d4",
};

const sizeOptionEstimateStyle: CSSProperties = {
  fontSize: 11,
  color: "#7c87ad",
};

function primaryBtnStyle(disabled: boolean): CSSProperties {
  return {
    background: disabled
      ? "rgba(255,255,255,0.08)"
      : "linear-gradient(120deg, #74b9ff 0%, #a55bff 100%)",
    color: disabled ? "#a8b3d4" : "#fff",
    border: "none",
    borderRadius: 999,
    padding: "12px 28px",
    fontSize: 14,
    fontWeight: 600,
    letterSpacing: "0.02em",
    cursor: disabled ? "not-allowed" : "pointer",
    boxShadow: disabled ? "none" : "0 12px 30px rgba(116,185,255,0.35)",
    transition: "transform 0.15s",
  };
}

const errorBoxStyle: CSSProperties = {
  marginTop: 18,
  padding: "12px 14px",
  background: "rgba(231,76,60,0.12)",
  border: "1px solid rgba(231,76,60,0.35)",
  borderRadius: 12,
  color: "#ffd2cf",
  fontSize: 13,
  lineHeight: 1.55,
};

const attachBtnStyle: CSSProperties = {
  marginTop: 8,
  background: "transparent",
  border: "1px solid rgba(255,210,207,0.45)",
  color: "#ffd2cf",
  borderRadius: 999,
  padding: "6px 14px",
  fontSize: 12,
  cursor: "pointer",
};

const errorTailStyle: CSSProperties = {
  marginTop: 8,
  padding: "10px 12px",
  background: "rgba(0,0,0,0.35)",
  borderRadius: 8,
  fontSize: 11,
  color: "#ffb0b0",
  maxHeight: 180,
  overflow: "auto",
  whiteSpace: "pre-wrap",
};

// Run view styles

const runHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 16,
  marginBottom: 22,
};

const runEyebrowStyle: CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "#8390b8",
  marginBottom: 6,
};

const runTitleStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  color: "#f6f9ff",
};

const runPromptStyle: CSSProperties = {
  marginTop: 8,
  color: "#a8b3d4",
  fontSize: 13,
  fontStyle: "italic",
  maxWidth: 540,
};

const stepperStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: 10,
};

const stepperItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 12px",
  background: "rgba(255,255,255,0.03)",
  borderRadius: 10,
};

function stepperBulletStyle(
  status: "done" | "active" | "pending" | "error",
): CSSProperties {
  const colors: Record<typeof status, { bg: string; color: string; border: string }> = {
    done: { bg: "rgba(76,209,148,0.18)", color: "#a3f7bf", border: "rgba(76,209,148,0.6)" },
    active: { bg: "rgba(116,185,255,0.22)", color: "#dff3ff", border: "rgba(116,185,255,0.7)" },
    pending: { bg: "rgba(255,255,255,0.06)", color: "#7c87ad", border: "rgba(255,255,255,0.12)" },
    error: { bg: "rgba(231,76,60,0.2)", color: "#ffd2cf", border: "rgba(231,76,60,0.6)" },
  };
  const c = colors[status];
  return {
    flex: "0 0 28px",
    width: 28,
    height: 28,
    borderRadius: 999,
    background: c.bg,
    color: c.color,
    border: `1px solid ${c.border}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 13,
    fontWeight: 700,
    boxShadow: status === "active" ? "0 0 16px rgba(116,185,255,0.4)" : "none",
    animation: status === "active" ? "spark-pulse 1.6s infinite" : "none",
  };
}

function stepperTitleStyle(
  status: "done" | "active" | "pending" | "error",
): CSSProperties {
  return {
    fontSize: 14,
    fontWeight: 600,
    color:
      status === "pending"
        ? "#7c87ad"
        : status === "error"
        ? "#ffd2cf"
        : "#e8ecff",
  };
}

const stepperHintStyle: CSSProperties = {
  fontSize: 12,
  color: "#7c87ad",
  marginTop: 2,
};

const milestonesStyle: CSSProperties = {
  marginTop: 16,
  padding: "10px 12px",
  background: "rgba(0,0,0,0.25)",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.06)",
  fontSize: 12,
  display: "grid",
  gap: 4,
};

function milestoneRowStyle(latest: boolean): CSSProperties {
  return {
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    minWidth: 0,
    color: latest ? "#dff3ff" : "#a8b3d4",
    opacity: latest ? 1 : 0.78,
  };
}

const milestoneTimeStyle: CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  color: "#7c87ad",
  flex: "0 0 64px",
};

const milestoneLabelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  whiteSpace: "normal",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
  lineHeight: 1.45,
};

const logsToggleStyle: CSSProperties = {
  marginTop: 16,
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.12)",
  color: "#a8b3d4",
  borderRadius: 999,
  padding: "6px 14px",
  fontSize: 12,
  cursor: "pointer",
};

const logsBoxStyle: CSSProperties = {
  marginTop: 10,
  padding: "12px 14px",
  background: "rgba(0,0,0,0.42)",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.08)",
  maxHeight: 240,
  overflow: "auto",
  fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
  fontSize: 11,
  lineHeight: 1.5,
  color: "#cfe9ff",
  wordBreak: "break-all",
  overflowWrap: "anywhere",
};

const tipStyle: CSSProperties = {
  marginTop: 18,
  fontSize: 12,
  color: "#7c87ad",
  textAlign: "center",
};

const spinnerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const runFooterControlsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  marginTop: 14,
};

function stopBtnStyle(disabled: boolean): CSSProperties {
  return {
    background: "transparent",
    color: disabled ? "#7782aa" : "#99a7d8",
    border: `1px solid ${disabled ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.14)"}`,
    borderRadius: 999,
    padding: "6px 12px",
    fontSize: 11,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.7 : 0.9,
  };
}

function spinnerDotStyle(idx: number): CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: "linear-gradient(135deg, #74b9ff, #a55bff)",
    boxShadow: "0 0 12px rgba(116,185,255,0.6)",
    animation: `spark-bob 1.2s ease-in-out ${idx * 0.15}s infinite`,
  };
}

const badgeDoneStyle: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 999,
  background: "rgba(76,209,148,0.22)",
  color: "#a3f7bf",
  border: "1px solid rgba(76,209,148,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 18,
  fontWeight: 700,
};

const badgeErrStyle: CSSProperties = {
  ...badgeDoneStyle,
  background: "rgba(231,76,60,0.2)",
  color: "#ffd2cf",
  border: "1px solid rgba(231,76,60,0.6)",
};

// Inject keyframes once via a global <style>.
if (typeof document !== "undefined" && !document.getElementById("worldspark-create-keyframes")) {
  const styleEl = document.createElement("style");
  styleEl.id = "worldspark-create-keyframes";
  styleEl.textContent = `
    @keyframes spark-pulse {
      0%, 100% { transform: scale(1); box-shadow: 0 0 14px rgba(116,185,255,0.45); }
      50% { transform: scale(1.06); box-shadow: 0 0 22px rgba(116,185,255,0.65); }
    }
    @keyframes spark-bob {
      0%, 100% { transform: translateY(0); opacity: 0.8; }
      50% { transform: translateY(-5px); opacity: 1; }
    }
  `;
  document.head.appendChild(styleEl);
}
