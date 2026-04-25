import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { CSSProperties, ChangeEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { WorldTimeInfo, TimelineMeta } from "../../types/api";
import { apiClient } from "../services/api-client";
import type { WorldInfo, GeneratedWorldSummary } from "../services/api-client";
import { GodPanel } from "./GodPanel";
import { SandboxChatPanel } from "./SandboxChatPanel";
import { TimelineManagerModal } from "./TimelineManagerModal";
import { LanguageToggle } from "../components/LanguageToggle";
import { translatePeriod } from "../utils/time-i18n";
import { sortLibraryWorldsForLocale } from "../utils/library-world-sort";

type ViewMode = "run" | "replay";

export function TopBar({
  worldInfo,
  gameTime,
  isDevMode,
  onToggleDevMode,
  showWalkableOverlay,
  showRegionBoundsOverlay,
  showMainAreaPointsOverlay,
  showInteractiveObjectsOverlay,
  onToggleWalkableOverlay,
  onToggleRegionBoundsOverlay,
  onToggleMainAreaPointsOverlay,
  onToggleInteractiveObjectsOverlay,
  onToggleAutoPlay,
  onNewTimeline,
  simStatus,
  autoPlayEnabled,
  isResetting,
  isReplaying,
  replayProgress,
  onHeightChange,
}: {
  worldInfo?: WorldInfo | null;
  gameTime: WorldTimeInfo;
  isDevMode: boolean;
  onToggleDevMode: () => void;
  showWalkableOverlay: boolean;
  showRegionBoundsOverlay: boolean;
  showMainAreaPointsOverlay: boolean;
  showInteractiveObjectsOverlay: boolean;
  onToggleWalkableOverlay: () => void;
  onToggleRegionBoundsOverlay: () => void;
  onToggleMainAreaPointsOverlay: () => void;
  onToggleInteractiveObjectsOverlay: () => void;
  onToggleAutoPlay: () => void;
  onNewTimeline: () => void;
  simStatus: "idle" | "running" | "paused" | "error";
  autoPlayEnabled: boolean;
  isResetting: boolean;
  isReplaying: boolean;
  replayProgress: { current: number; total: number } | null;
  onHeightChange?: (height: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [availableWorlds, setAvailableWorlds] = useState<GeneratedWorldSummary[]>([]);
  const [libraryWorlds, setLibraryWorlds] = useState<GeneratedWorldSummary[]>([]);
  const [selectedWorldId, setSelectedWorldId] = useState("");
  const [isSwitchingWorld, setIsSwitchingWorld] = useState(false);
  const [godPanelOpen, setGodPanelOpen] = useState(false);
  const [sandboxChatOpen, setSandboxChatOpen] = useState(false);
  const [showPauseToast, setShowPauseToast] = useState(false);
  const [isChangingTickGranularity, setIsChangingTickGranularity] = useState(false);
  const [managerModalOpen, setManagerModalOpen] = useState(false);
  const [timelines, setTimelines] = useState<TimelineMeta[]>([]);
  const [selectedTimelineId, setSelectedTimelineId] = useState("");
  const [isSwitchingTimeline, setIsSwitchingTimeline] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => new URLSearchParams(window.location.search).get("mode") === "replay" ? "replay" : "run",
  );
  const barRef = useRef<HTMLDivElement | null>(null);
  const isRunning = simStatus === "running";
  const isBusy = isRunning || isResetting || isSwitchingWorld || isSwitchingTimeline || isChangingTickGranularity;
  const autoPlayToggleDisabled =
    isResetting || isSwitchingWorld || isSwitchingTimeline || isChangingTickGranularity || (isRunning && !autoPlayEnabled);

  const inRunMode = viewMode === "run" && !isReplaying;
  const inReplayMode = viewMode === "replay" || isReplaying;

  const wasReplayingRef = useRef(isReplaying);
  useEffect(() => {
    if (wasReplayingRef.current && !isReplaying && viewMode === "replay") {
      setViewMode("run");
    }
    wasReplayingRef.current = isReplaying;
  }, [isReplaying, viewMode]);

  useEffect(() => {
    let cancelled = false;
    const lang = i18n.resolvedLanguage || i18n.language || "en";
    apiClient.getGeneratedWorlds()
      .then((response) => {
        if (cancelled) return;
        setAvailableWorlds(response.worlds);
        setLibraryWorlds(response.libraryWorlds ?? []);
        const sortedLib = sortLibraryWorldsForLocale(response.libraryWorlds ?? [], lang);
        const merged = [...response.worlds, ...sortedLib];
        const defaultWorldId =
          response.currentWorldId ||
          merged.find((world) => world.isCurrent)?.id ||
          merged[0]?.id ||
          "";
        if (defaultWorldId) setSelectedWorldId(defaultWorldId);
      })
      .catch(() => {});

    apiClient.getTimelines()
      .then((response) => {
        if (cancelled) return;
        setTimelines(response.timelines);
        if (response.currentTimelineId) setSelectedTimelineId(response.currentTimelineId);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [i18n.resolvedLanguage, i18n.language]);

  useEffect(() => {
    if (worldInfo?.currentWorldId) setSelectedWorldId(worldInfo.currentWorldId);
    if (worldInfo?.currentTimelineId) setSelectedTimelineId(worldInfo.currentTimelineId);
  }, [worldInfo?.currentWorldId, worldInfo?.currentTimelineId]);

  useEffect(() => {
    if (!onHeightChange || !barRef.current) return;
    const node = barRef.current;
    const notifyHeight = () => onHeightChange(Math.ceil(node.getBoundingClientRect().height));
    notifyHeight();
    const observer = new ResizeObserver(notifyHeight);
    observer.observe(node);
    window.addEventListener("resize", notifyHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", notifyHeight);
    };
  }, [onHeightChange]);

  const handleSwitchToReplay = async () => {
    try {
      const fresh = await apiClient.getTimelines();
      const currentTl = fresh.timelines.find((tl) => tl.id === selectedTimelineId);
      if (!currentTl || currentTl.tickCount <= 0) {
        window.alert(t("topbar.noReplayDataAlert"));
        return;
      }
    } catch {
      /* network error — let the page reload attempt replay anyway */
    }
    const params = new URLSearchParams(window.location.search);
    params.set("mode", "replay");
    window.location.search = params.toString();
  };

  const handleSwitchToRun = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete("mode");
    window.location.search = params.toString();
  };

  const statusLabel =
    inReplayMode
      ? (isReplaying ? t("topbar.statusReplaying") : t("topbar.statusReplayReady"))
      : isSwitchingWorld
      ? t("topbar.statusSwitchingWorld")
      : isSwitchingTimeline
      ? t("topbar.statusSwitchingTimeline")
      : isResetting
      ? t("topbar.statusCreatingTimeline")
      : simStatus === "running"
      ? t("topbar.statusSimulating")
      : autoPlayEnabled
        ? t("topbar.statusAutoPlay")
      : simStatus === "paused"
        ? t("topbar.statusPaused")
        : simStatus === "error"
          ? t("topbar.statusError")
          : t("topbar.statusIdle");
  const statusColor =
    inReplayMode
      ? "var(--hud-gold)"
      : isSwitchingWorld || isSwitchingTimeline
      ? "var(--hud-blue)"
      : isResetting
      ? "var(--hud-gold)"
      : simStatus === "running"
      ? "var(--hud-green)"
      : simStatus === "error"
        ? "var(--hud-red)"
        : simStatus === "paused"
          ? "var(--hud-dim)"
          : "var(--hud-blue)";

  const pauseWorldIfNeeded = () => {
    if (!autoPlayEnabled) return;
    onToggleAutoPlay();
    setShowPauseToast(true);
    setTimeout(() => setShowPauseToast(false), 3500);
  };

  const worldName = worldInfo?.worldName || "WorldX";
  const period = gameTime.period ? translatePeriod(gameTime.period) : "";
  const timeLabel = gameTime.timeString
    ? (period
      ? t("topbar.dayTimePeriod", { day: gameTime.day, time: gameTime.timeString, period })
      : t("topbar.dayTime", { day: gameTime.day, time: gameTime.timeString }))
    : t("topbar.dayOnly", { day: gameTime.day });

  const handleTimelineChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextTimelineId = event.target.value;
    if (!nextTimelineId || nextTimelineId === selectedTimelineId) return;
    const confirmed = window.confirm(t("topbar.confirmSwitchTimeline"));
    if (!confirmed) return;
    setSelectedTimelineId(nextTimelineId);
    setIsSwitchingTimeline(true);
    try {
      await apiClient.loadTimeline(nextTimelineId);
      const params = new URLSearchParams(window.location.search);
      if (inReplayMode) params.set("mode", "replay");
      window.location.search = params.toString();
    } catch (error) {
      console.warn("[TopBar] Failed to switch timeline:", error);
      window.alert(t("topbar.switchFailed", { error: error instanceof Error ? error.message : String(error) }));
      setIsSwitchingTimeline(false);
    }
  };

  const handleDevTickGranularityChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextValue = Number(event.target.value);
    const currentValue = worldInfo?.sceneConfig.tickDurationMinutes ?? 15;
    if (nextValue === currentValue) return;
    const confirmed = window.confirm(
      t("topbar.confirmSwitchTickGranularity", { value: nextValue }),
    );
    if (!confirmed) { event.target.value = String(currentValue); return; }
    setIsChangingTickGranularity(true);
    try {
      await apiClient.setDevTickDurationMinutes(nextValue as 15 | 30 | 60);
      window.location.reload();
    } catch (error) {
      console.warn("[TopBar] Failed to change dev tick granularity:", error);
      window.alert(t("topbar.updateFailed", { error: error instanceof Error ? error.message : String(error) }));
      setIsChangingTickGranularity(false);
    }
  };

  const sortedLibraryWorlds = useMemo(
    () =>
      sortLibraryWorldsForLocale(
        libraryWorlds,
        i18n.resolvedLanguage || i18n.language || "en",
      ),
    [libraryWorlds, i18n.resolvedLanguage, i18n.language],
  );
  const allWorlds = [...availableWorlds, ...sortedLibraryWorlds];

  const handleWorldChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextWorldId = event.target.value;
    if (!nextWorldId || nextWorldId === selectedWorldId) return;
    const nextWorld = allWorlds.find((world) => world.id === nextWorldId);
    const confirmed = window.confirm(
      t("topbar.confirmSwitchWorld", { name: nextWorld?.worldName ?? nextWorldId }),
    );
    if (!confirmed) return;
    const previousWorldId = selectedWorldId;
    setSelectedWorldId(nextWorldId);
    setIsSwitchingWorld(true);
    try {
      await apiClient.switchWorld(nextWorldId);
      const params = new URLSearchParams(window.location.search);
      if (inReplayMode) params.set("mode", "replay");
      window.location.search = params.toString();
    } catch (error) {
      setSelectedWorldId(previousWorldId);
      console.warn("[TopBar] Failed to switch world:", error);
      window.alert(t("topbar.switchFailed", { error: error instanceof Error ? error.message : String(error) }));
      setIsSwitchingWorld(false);
    }
  };

  return (
    <div
      ref={barRef}
      style={{
        position: "fixed",
        top: 12,
        left: 12,
        right: 12,
        background:
          "linear-gradient(180deg, rgba(14, 14, 14, 0.94), rgba(5, 5, 5, 0.86)), var(--hud-stripe)",
        backdropFilter: "blur(10px) saturate(1.06)",
        display: "flex",
        flexDirection: "column",
        padding: "8px 10px 9px",
        gap: 8,
        color: "var(--hud-text)",
        fontSize: 13,
        zIndex: 140,
        border: "1px solid rgba(255,255,255,0.2)",
        borderLeft: "5px solid var(--hud-gold)",
        borderRadius: "var(--hud-radius)",
        boxShadow: "var(--hud-shadow)",
        pointerEvents: "auto",
        maxHeight: "min(154px, calc(100vh - 24px))",
        overflowY: "auto",
        scrollbarWidth: "none",
      }}
    >
      {/* Row 1: status info + world/timeline selectors + mode toggle + play */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        {/* Left: world name + status + time */}
        <div style={worldIdentityStyle}>
          <span style={worldMarkStyle}>界</span>
          <span style={{ fontWeight: 800, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
            {worldName}
          </span>
          <span style={{
            width: 8, height: 8, borderRadius: "50%",
            background: statusColor,
            animation: (isBusy || isReplaying) ? "pulse 1s infinite" : "pulse 2s infinite",
            flexShrink: 0,
            boxShadow: `0 0 0 2px rgba(0,0,0,0.78), 0 0 12px ${statusColor}`,
          }} />
          <span style={{ fontSize: 11, color: "var(--hud-muted)", whiteSpace: "nowrap" }}>{statusLabel}</span>
          <span style={{ opacity: 0.35 }}>|</span>
          <span style={timePillStyle}>{timeLabel}</span>
        </div>

        {/* Right: mode toggle + play/pause */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginLeft: "auto" }}>
          {/* Mode toggle: Run / Replay */}
          <div style={modeToggleContainerStyle}>
            <button
              onClick={handleSwitchToRun}
              disabled={isBusy}
              style={modeToggleBtnStyle(inRunMode, "run")}
            >
              {t("topbar.run")}
            </button>
            <button
              onClick={handleSwitchToReplay}
              disabled={isBusy}
              style={modeToggleBtnStyle(inReplayMode, "replay")}
              title={t("topbar.switchToReplay")}
            >
              {t("topbar.replay")}
            </button>
          </div>

          {/* Play / Pause — adapts to mode */}
          <button
            onClick={onToggleAutoPlay}
            disabled={inRunMode ? autoPlayToggleDisabled : false}
            style={{
              ...primaryBtnStyle,
              background: autoPlayEnabled
                ? "var(--hud-paper)"
                : "var(--hud-gold)",
              borderColor: "rgba(0,0,0,0.78)",
              color: "#0b0b0b",
              cursor: (inRunMode && autoPlayToggleDisabled) ? "wait" : "pointer",
              opacity: (inRunMode && autoPlayToggleDisabled) ? 0.6 : 1,
              minWidth: 88,
            }}
          >
            {autoPlayEnabled
              ? (inReplayMode ? t("topbar.pauseReplay") : t("topbar.pauseRun"))
              : (inReplayMode ? t("topbar.playReplay") : t("topbar.playRun"))}
          </button>
        </div>
      </div>

      {/* Replay progress bar (only in replay mode) */}
      {inReplayMode && replayProgress && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 2px" }}>
          <span style={{ fontSize: 11, color: "var(--hud-gold)", fontWeight: 800, whiteSpace: "nowrap" }}>
            {replayProgress.current}/{replayProgress.total}
          </span>
          <div style={{ flex: 1, height: 5, background: "rgba(255,255,255,0.1)", borderRadius: 1, overflow: "hidden" }}>
            <div style={{
              height: "100%",
              width: `${replayProgress.total > 0 ? (replayProgress.current / replayProgress.total) * 100 : 0}%`,
              background: "linear-gradient(90deg, var(--hud-gold), var(--hud-blue))",
              borderRadius: 1,
              transition: "width 0.3s ease",
            }} />
          </div>
        </div>
      )}

      {/* Row 2: Management + Tools */}
      <div style={commandRowStyle}>
        
        {/* Left: World & Timeline Management */}
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", minWidth: 0 }}>
          {/* World selector */}
          {allWorlds.length > 0 && (
            <div style={fieldGroupStyle}>
              <span style={fieldLabelStyle}>{t("topbar.worldLabel")}</span>
              <select value={selectedWorldId} onChange={handleWorldChange}
                disabled={isBusy} style={{ ...selectStyle, maxWidth: 180 }}>
                {availableWorlds.length > 0 && (
                  <optgroup label={t("topbar.myWorlds")}>
                    {availableWorlds.map((world) => (
                      <option key={world.id} value={world.id}>{world.worldName}</option>
                    ))}
                  </optgroup>
                )}
                {sortedLibraryWorlds.length > 0 && (
                  <optgroup label={t("topbar.sampleWorlds")}>
                    {sortedLibraryWorlds.map((world) => (
                      <option key={world.id} value={world.id}>{world.worldName}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          )}

          {/* Timeline selector */}
          {timelines.length > 0 && (
            <div style={fieldGroupStyle}>
              <span style={fieldLabelStyle}>{t("topbar.timelineLabel")}</span>
              <select value={selectedTimelineId} onChange={handleTimelineChange}
                disabled={isBusy} style={{ ...selectStyle, maxWidth: 180 }}>
                {timelines.map((tl, idx) => (
                  <option key={tl.id} value={tl.id}>{formatTimelineLabel(tl, timelines.length - idx)}</option>
                ))}
              </select>
            </div>
          )}

          <button onClick={() => setManagerModalOpen(true)} disabled={isBusy}
            style={chipBtnStyle(managerModalOpen)}
            title={t("topbar.manageTitle")}>
            {t("topbar.manage")}
          </button>

          {inRunMode && (
            <>
              <span style={dividerStyle} />
              <button
                onClick={onNewTimeline}
                disabled={isBusy}
                style={{
                  ...secondaryBtnStyle,
                  borderRadius: 999,
                  color: "var(--hud-blue)",
                  borderColor: "rgba(68,216,255,0.5)",
                  background: "rgba(68,216,255,0.12)",
                  cursor: isBusy ? "wait" : "pointer",
                  opacity: isBusy ? 0.7 : 1,
                }}
              >
                {isResetting ? t("topbar.creatingTimeline") : t("topbar.newTimeline")}
              </button>
              <button
                onClick={() => { pauseWorldIfNeeded(); navigate("/create"); }}
                disabled={isResetting || isSwitchingWorld}
                style={newWorldBtnStyle(isResetting || isSwitchingWorld)}
                title={t("topbar.newWorldTitle")}
              >
                {t("topbar.newWorld")}
              </button>
            </>
          )}
        </div>

        {/* Right: feature entries + tools */}
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", justifyContent: "flex-end", marginLeft: "auto" }}>
          <button onClick={() => navigate("/timeline")} style={chipBtnStyle(false)}>{t("topbar.eventLog")}</button>
          <button
            onClick={() => setGodPanelOpen(true)}
            disabled={inReplayMode}
            style={{ ...chipBtnStyle(godPanelOpen), opacity: inReplayMode ? 0.4 : 1, cursor: inReplayMode ? "not-allowed" : "pointer" }}
            title={t("topbar.godModeTitle")}
          >
            {t("topbar.godMode")}
          </button>
          <button
            onClick={() => { setSandboxChatOpen(true); pauseWorldIfNeeded(); }}
            disabled={inReplayMode}
            style={{ ...chipBtnStyle(sandboxChatOpen), opacity: inReplayMode ? 0.4 : 1, cursor: inReplayMode ? "not-allowed" : "pointer" }}
            title={t("topbar.sandboxChatTitle")}
          >
            {t("topbar.sandboxChat")}
          </button>

          {isDevMode && (
            <>
              <span style={dividerStyle} />
              <div style={fieldGroupStyle}>
                <span style={fieldLabelStyle}>{t("topbar.tickLabel")}</span>
                <select
                  value={String(worldInfo?.sceneConfig.tickDurationMinutes ?? 15)}
                  onChange={handleDevTickGranularityChange}
                  disabled={isBusy || inReplayMode}
                  style={selectStyle}
                  title={t("topbar.tickTitle")}
                >
                  <option value="15">15 min</option>
                  <option value="30">30 min</option>
                  <option value="60">1 h</option>
                </select>
              </div>
              <button onClick={onToggleWalkableOverlay} style={chipBtnStyle(showWalkableOverlay)}>{t("topbar.devWalkable")}</button>
              <button onClick={onToggleRegionBoundsOverlay} style={chipBtnStyle(showRegionBoundsOverlay)}>{t("topbar.devRegions")}</button>
              <button onClick={onToggleMainAreaPointsOverlay} style={chipBtnStyle(showMainAreaPointsOverlay)}>{t("topbar.devPoints")}</button>
              <button onClick={onToggleInteractiveObjectsOverlay} style={chipBtnStyle(showInteractiveObjectsOverlay)}>{t("topbar.devInteractive")}</button>
            </>
          )}

          <span style={dividerStyle} />

          <button 
            onClick={onToggleDevMode} 
            style={chipBtnStyle(isDevMode)} 
            title={isDevMode ? t("topbar.disableDevMode") : t("topbar.enableDevMode")}
          >
            {isDevMode ? "DEV ON" : "DEV"}
          </button>

          <LanguageToggle />
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes slideDownFade {
          0% { opacity: 0; transform: translate(-50%, -10px); }
          10% { opacity: 1; transform: translate(-50%, 0); }
          90% { opacity: 1; transform: translate(-50%, 0); }
          100% { opacity: 0; transform: translate(-50%, -10px); }
        }
      `}</style>

      {showPauseToast && typeof document !== "undefined" && createPortal(
        <div style={{
          position: "fixed", top: 72, left: "50%", transform: "translateX(-50%)",
          background: "rgba(8, 8, 8, 0.95)", border: "1px solid rgba(255,216,77,0.5)",
          color: "var(--hud-gold)", padding: "8px 16px", borderRadius: 4, fontSize: 13, fontWeight: 800,
          zIndex: 9999, boxShadow: "var(--hud-shadow)", animation: "slideDownFade 3.5s forwards",
          pointerEvents: "none", display: "flex", alignItems: "center", gap: 6,
          clipPath: "var(--hud-cut-corners)",
        }}>
          <span>⏸️</span> {t("topbar.pauseToast")}
        </div>,
        document.body
      )}

      {godPanelOpen && typeof document !== "undefined"
        ? createPortal(<GodPanel onClose={() => setGodPanelOpen(false)} />, document.body)
        : null}
      {sandboxChatOpen && typeof document !== "undefined"
        ? createPortal(<SandboxChatPanel onClose={() => setSandboxChatOpen(false)} />, document.body)
        : null}
      {managerModalOpen && typeof document !== "undefined"
        ? createPortal(<TimelineManagerModal onClose={() => setManagerModalOpen(false)} />, document.body)
        : null}
    </div>
  );
}

// --- Styles ---

const primaryBtnStyle: CSSProperties = {
  color: "#0a0a0a",
  borderRadius: 3,
  padding: "8px 17px",
  fontSize: 12,
  border: "1px solid",
  fontWeight: 900,
  boxShadow: "4px 4px 0 rgba(0,0,0,0.36)",
  transition: "all 0.2s",
  clipPath: "var(--hud-cut-corners)",
};

const secondaryBtnStyle: CSSProperties = {
  background: "rgba(12,12,12,0.78)",
  border: "1px solid rgba(255,255,255,0.16)",
  color: "var(--hud-text)",
  borderRadius: 3,
  padding: "7px 11px",
  fontSize: 12,
  fontWeight: 850,
  clipPath: "var(--hud-cut-corners)",
};

const selectStyle: CSSProperties = {
  background: "rgba(5,5,5,0.82)",
  border: "1px solid rgba(255,255,255,0.22)",
  color: "var(--hud-text)",
  borderRadius: 3,
  padding: "7px 10px",
  fontSize: 12,
  outline: "none",
  boxShadow: "2px 2px 0 rgba(0,0,0,0.25)",
};

function chipBtnStyle(active: boolean): CSSProperties {
  return {
    background: active
      ? "var(--hud-gold)"
      : "rgba(255,255,255,0.07)",
    border: `1px solid ${active ? "rgba(0,0,0,0.78)" : "rgba(255,255,255,0.16)"}`,
    color: active ? "var(--hud-ink)" : "var(--hud-text)",
    borderRadius: 3,
    padding: "7px 11px",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: active ? 900 : 750,
    transition: "all 0.2s",
    boxShadow: active ? "4px 4px 0 rgba(0,0,0,0.32)" : "none",
    clipPath: "var(--hud-cut-corners)",
  };
}

function newWorldBtnStyle(disabled: boolean): CSSProperties {
  return {
    background: disabled
      ? "rgba(255,255,255,0.08)"
      : "var(--hud-paper)",
    border: "1px solid rgba(0,0,0,0.82)",
    color: "#0b0b0b",
    borderRadius: 3,
    padding: "7px 14px",
    cursor: disabled ? "wait" : "pointer",
    fontSize: 12,
    fontWeight: 900,
    letterSpacing: 0,
    boxShadow: disabled ? "none" : "4px 4px 0 rgba(0,0,0,0.34)",
    transition: "all 0.2s",
    opacity: disabled ? 0.7 : 1,
    clipPath: "var(--hud-cut-corners)",
  };
}

const modeToggleContainerStyle: CSSProperties = {
  display: "inline-flex",
  borderRadius: 3,
  border: "1px solid rgba(255,255,255,0.18)",
  overflow: "hidden",
  background: "rgba(0,0,0,0.5)",
  boxShadow: "3px 3px 0 rgba(0,0,0,0.28)",
  clipPath: "var(--hud-cut-corners)",
};

function formatTimelineLabel(tl: TimelineMeta, index: number): string {
  let timeStr = "";
  if (tl.createdAt) {
    const d = new Date(tl.createdAt);
    if (!isNaN(d.getTime())) {
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      timeStr = `${mm}/${dd} ${hh}:${min}`;
    }
  }
  const tickLabel = `${tl.tickCount}t`;
  return timeStr ? `#${index} · ${timeStr} (${tickLabel})` : `#${index} (${tickLabel})`;
}

function modeToggleBtnStyle(active: boolean, mode: ViewMode): CSSProperties {
  const colors = mode === "run"
    ? { activeBg: "var(--hud-gold)", activeColor: "var(--hud-ink)" }
    : { activeBg: "var(--hud-paper)", activeColor: "var(--hud-ink)" };

  return {
    background: active ? colors.activeBg : "transparent",
    border: "none",
    borderRight: mode === "run" ? "1px solid rgba(255,255,255,0.16)" : "none",
    color: active ? colors.activeColor : "rgba(255,255,255,0.55)",
    padding: "7px 14px",
    fontSize: 12,
    fontWeight: active ? 900 : 750,
    cursor: "pointer",
    transition: "all 0.2s",
    whiteSpace: "nowrap",
  };
}

const worldIdentityStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  minWidth: 0,
  flex: "1 1 320px",
  padding: "5px 10px 5px 5px",
  borderRadius: 3,
  background: "linear-gradient(90deg, rgba(255,255,255,0.13), rgba(255,255,255,0.045))",
  border: "1px solid rgba(255,255,255,0.16)",
  clipPath: "var(--hud-cut-corners)",
};

const worldMarkStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 2,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  background: "var(--hud-gold)",
  border: "1px solid rgba(0,0,0,0.72)",
  color: "var(--hud-ink)",
  fontWeight: 900,
  boxShadow: "3px 3px 0 rgba(0,0,0,0.32)",
  clipPath: "polygon(6px 0, 100% 0, 100% 100%, 0 100%, 0 6px)",
};

const timePillStyle: CSSProperties = {
  borderRadius: 2,
  padding: "4px 9px 5px",
  background: "var(--hud-paper)",
  border: "1px solid rgba(0,0,0,0.72)",
  color: "var(--hud-ink)",
  fontSize: 12,
  fontWeight: 900,
  whiteSpace: "nowrap",
  clipPath: "var(--hud-cut-corners)",
};

const commandRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  flexWrap: "wrap",
  padding: 6,
  borderRadius: 3,
  background: "rgba(255, 255, 255, 0.045)",
  border: "1px solid rgba(255,255,255,0.1)",
};

const fieldGroupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
};

const fieldLabelStyle: CSSProperties = {
  fontSize: 10,
  color: "var(--hud-dim)",
  letterSpacing: 0,
  textTransform: "uppercase",
  whiteSpace: "nowrap",
  fontWeight: 850,
};

const dividerStyle: CSSProperties = {
  width: 2,
  height: 20,
  background: "linear-gradient(180deg, transparent, var(--hud-gold), transparent)",
  flexShrink: 0,
  margin: "0 2px",
};
