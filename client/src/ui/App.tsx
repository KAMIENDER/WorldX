import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { useState, useEffect, useCallback, Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import Phaser from "phaser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TopBar } from "./panels/TopBar";
import { SidePanel } from "./panels/SidePanel";
import { MapControls } from "./panels/MapControls";
import { DialoguePanel } from "./panels/DialoguePanel";
import { SceneTransition } from "./panels/SceneTransition";
import { RelationshipGraph } from "./pages/RelationshipGraph";
import { Timeline } from "./pages/Timeline";
import type { SimulationEvent, DialogueEventData, WorldTimeInfo } from "../types/api";
import { apiClient } from "./services/api-client";
import type { WorldInfo } from "./services/api-client";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5000,
      refetchOnWindowFocus: false,
    },
  },
});

const DEFAULT_TOP_BAR_HEIGHT = 52;

class OverlayErrorBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("[OverlayErrorBoundary]", error, info);
    this.props.onError();
  }
  render() { return this.state.hasError ? null : this.props.children; }
}

export function App({ eventBus }: { eventBus: Phaser.Events.EventEmitter }) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppContent eventBus={eventBus} />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function AppContent({ eventBus }: { eventBus: Phaser.Events.EventEmitter }) {
  const location = useLocation();
  const navigate = useNavigate();
  const isDevMode = new URLSearchParams(location.search).get("dev") === "1";
  const [gameTime, setGameTime] = useState<WorldTimeInfo>({
    day: 1,
    tick: 0,
    timeString: "08:00",
    period: "上午",
  });
  const [worldInfo, setWorldInfo] = useState<WorldInfo | null>(null);
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
  const [followedCharId, setFollowedCharId] = useState<string | null>(null);
  const [events, setEvents] = useState<SimulationEvent[]>([]);
  const [simStatus, setSimStatus] = useState<"idle" | "running" | "paused" | "error">("idle");
  const [autoPlayEnabled, setAutoPlayEnabled] = useState(false);
  const [tickIntervalMs, setTickIntervalMs] = useState(0);
  const [isResetting, setIsResetting] = useState(false);
  const [dialogueEvents, setDialogueEvents] = useState<SimulationEvent[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [transitionDay, setTransitionDay] = useState<number | null>(null);
  const [lastKnownDay, setLastKnownDay] = useState(1);
  const [topBarHeight, setTopBarHeight] = useState(DEFAULT_TOP_BAR_HEIGHT);
  const [showWalkableOverlay, setShowWalkableOverlay] = useState(false);
  const [showRegionBoundsOverlay, setShowRegionBoundsOverlay] = useState(false);
  const [showMainAreaPointsOverlay, setShowMainAreaPointsOverlay] = useState(false);
  const [showInteractiveObjectsOverlay, setShowInteractiveObjectsOverlay] = useState(false);
  const isOverlayRoute =
    location.pathname === "/graph" || location.pathname === "/timeline";
  const ticksPerScene = worldInfo?.sceneRuntime.cycleTicks ?? 48;
  const showDayTransition = worldInfo?.sceneRuntime.transitionEnabled ?? false;
  const transitionTitle =
    worldInfo?.sceneConfig.multiDay.dayTransitionText ||
    (worldInfo?.sceneConfig.sceneType === "open" ? "夜色缓缓换了一幕" : "新的一天开始了");

  useEffect(() => {
    const topOffset = isOverlayRoute ? 0 : Math.max(topBarHeight, DEFAULT_TOP_BAR_HEIGHT);
    document.documentElement.style.setProperty("--top-ui-offset", `${topOffset}px`);

    const rafId = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [isOverlayRoute, topBarHeight]);

  useEffect(() => {
    if (isDevMode) return;
    setShowWalkableOverlay(false);
    setShowRegionBoundsOverlay(false);
    setShowMainAreaPointsOverlay(false);
    setShowInteractiveObjectsOverlay(false);
  }, [isDevMode]);

  useEffect(() => {
    eventBus.emit("toggle_debug_walkable_overlay", isDevMode && showWalkableOverlay);
  }, [eventBus, isDevMode, showWalkableOverlay]);

  useEffect(() => {
    eventBus.emit("toggle_debug_region_bounds_overlay", isDevMode && showRegionBoundsOverlay);
  }, [eventBus, isDevMode, showRegionBoundsOverlay]);

  useEffect(() => {
    eventBus.emit("toggle_debug_main_area_points_overlay", isDevMode && showMainAreaPointsOverlay);
  }, [eventBus, isDevMode, showMainAreaPointsOverlay]);

  useEffect(() => {
    eventBus.emit("toggle_debug_interactive_objects_overlay", isDevMode && showInteractiveObjectsOverlay);
  }, [eventBus, isDevMode, showInteractiveObjectsOverlay]);

  useEffect(() => {
    if (!showDayTransition) {
      if (transitionDay !== null) setTransitionDay(null);
      if (lastKnownDay !== gameTime.day) setLastKnownDay(gameTime.day);
      return;
    }

    if (gameTime.day > lastKnownDay) {
      setTransitionDay(gameTime.day);
      setLastKnownDay(gameTime.day);
      return;
    }
    if (gameTime.day < lastKnownDay) {
      setLastKnownDay(gameTime.day);
    }
  }, [gameTime.day, lastKnownDay, showDayTransition, transitionDay]);

  useEffect(() => {
    let cancelled = false;
    apiClient.getWorldInfo()
      .then((info) => {
        if (!cancelled) {
          setWorldInfo(info);
        }
      })
      .catch((error) => {
        console.warn("[App] Failed to load world info:", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onTimeUpdate = (time: WorldTimeInfo) => setGameTime(time);
    const onCharClick = (id: string) => setSelectedCharId(id);
    const onSimEvent = (event: SimulationEvent) => {
      setEvents((prev) => [event, ...prev].slice(0, 50));
    };
    const onSimStatus = (payload: { status?: "idle" | "running" | "paused" | "error" }) => {
      if (payload.status) setSimStatus(payload.status);
    };
    const onDialogue = (event: SimulationEvent) => {
      const dialogue = event.data as DialogueEventData | undefined;
      if (dialogue?.conversationId) {
        setDismissedIds((prev) => {
          if (!prev.has(dialogue.conversationId)) return prev;
          const next = new Set(prev);
          next.delete(dialogue.conversationId);
          return next;
        });
      }
      setDialogueEvents((prev) => [...prev, event]);
    };
    const onPlaybackState = (payload: { autoPlay?: boolean; tickIntervalMs?: number }) => {
      if (payload.autoPlay != null) setAutoPlayEnabled(payload.autoPlay);
      if (payload.tickIntervalMs != null) setTickIntervalMs(payload.tickIntervalMs);
    };

    eventBus.on("time_update", onTimeUpdate);
    eventBus.on("character_clicked", onCharClick);
    eventBus.on("sim_event", onSimEvent);
    eventBus.on("simulation_status", onSimStatus);
    eventBus.on("dialogue", onDialogue);
    eventBus.on("playback_state", onPlaybackState);

    return () => {
      eventBus.off("time_update", onTimeUpdate);
      eventBus.off("character_clicked", onCharClick);
      eventBus.off("sim_event", onSimEvent);
      eventBus.off("simulation_status", onSimStatus);
      eventBus.off("dialogue", onDialogue);
      eventBus.off("playback_state", onPlaybackState);
    };
  }, [eventBus]);


  const handleToggleAutoPlay = useCallback(() => {
    eventBus.emit("set_auto_play", !autoPlayEnabled);
  }, [autoPlayEnabled, eventBus]);

  const handleChangeTickInterval = useCallback((intervalMs: number) => {
    eventBus.emit("set_tick_interval", intervalMs);
  }, [eventBus]);

  const handleResetWorld = useCallback(async () => {
    const confirmed = window.confirm(
      "This will reset all simulation state (time, events, memories, relationships). Continue?",
    );
    if (!confirmed) return;

    setIsResetting(true);
    try {
      await apiClient.resetWorld();
      window.location.reload();
    } catch (error) {
      console.warn("[App] Failed to reset world:", error);
      window.alert(`Reset failed: ${error instanceof Error ? error.message : String(error)}`);
      setIsResetting(false);
    }
  }, []);

  const handleToggleFollowChar = useCallback(
    (id: string) => {
      if (followedCharId === id) {
        eventBus.emit("unfollow_character");
        setFollowedCharId(null);
        return;
      }

      eventBus.emit("follow_character", id);
      setFollowedCharId(id);
    },
    [eventBus, followedCharId]
  );

  const handleOverlayError = useCallback(() => {
    navigate("/");
  }, [navigate]);

  const overlayContent =
    location.pathname === "/graph" ? (
      <RelationshipGraph />
    ) : location.pathname === "/timeline" ? (
      <Timeline />
    ) : null;

  const overlay = overlayContent ? (
    <OverlayErrorBoundary key={location.pathname} onError={handleOverlayError}>
      {overlayContent}
    </OverlayErrorBoundary>
  ) : null;

  return (
    <div style={{ width: "100%", height: "100%", pointerEvents: "none" }}>
      {!isOverlayRoute && (
        <>
          <TopBar
            worldInfo={worldInfo}
            gameTime={gameTime}
            isDevMode={isDevMode}
            showWalkableOverlay={showWalkableOverlay}
            showRegionBoundsOverlay={showRegionBoundsOverlay}
            showMainAreaPointsOverlay={showMainAreaPointsOverlay}
            showInteractiveObjectsOverlay={showInteractiveObjectsOverlay}
            onToggleWalkableOverlay={() => setShowWalkableOverlay((prev) => !prev)}
            onToggleRegionBoundsOverlay={() => setShowRegionBoundsOverlay((prev) => !prev)}
            onToggleMainAreaPointsOverlay={() => setShowMainAreaPointsOverlay((prev) => !prev)}
            onToggleInteractiveObjectsOverlay={() => setShowInteractiveObjectsOverlay((prev) => !prev)}
            onToggleAutoPlay={handleToggleAutoPlay}
            onChangeTickInterval={handleChangeTickInterval}
            onResetWorld={handleResetWorld}
            simStatus={simStatus}
            autoPlayEnabled={autoPlayEnabled}
            tickIntervalMs={tickIntervalMs}
            isResetting={isResetting}
            onHeightChange={setTopBarHeight}
          />
          <SidePanel
            selectedCharId={selectedCharId}
            followedCharId={followedCharId}
            onSelect={setSelectedCharId}
            onToggleFollow={handleToggleFollowChar}
            events={events}
          />
          <DialoguePanel
            events={dialogueEvents.filter(
              (e) => {
                const d = e.data as DialogueEventData | undefined;
                return d?.conversationId && !dismissedIds.has(d.conversationId);
              }
            )}
            currentTime={gameTime}
            ticksPerScene={ticksPerScene}
            onDismiss={(id) => setDismissedIds((prev) => new Set(prev).add(id))}
          />
          <MapControls eventBus={eventBus} />
          <SceneTransition
            day={transitionDay ?? 1}
            visible={transitionDay !== null}
            title={transitionTitle}
            timeString={gameTime.timeString || worldInfo?.sceneConfig.multiDay.nextDayStartTime}
            periodLabel={gameTime.period}
            variant={worldInfo?.sceneConfig.sceneType === "open" ? "open" : "closed"}
            onComplete={() => setTransitionDay(null)}
          />
        </>
      )}
      {overlay}
    </div>
  );
}
