import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useState, useEffect, useCallback, useRef, Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { createPortal } from "react-dom";
import Phaser from "phaser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TopBar } from "./panels/TopBar";
import { SidePanel } from "./panels/SidePanel";
import { MapControls } from "./panels/MapControls";
import { DialoguePanel } from "./panels/DialoguePanel";
import { RuntimeStatePanel } from "./panels/RuntimeStatePanel";
import { PossessionPanel } from "./panels/PossessionPanel";
import { SceneTransition } from "./panels/SceneTransition";
import { WorldIntroBanner } from "./panels/WorldIntroBanner";
import { Timeline } from "./pages/Timeline";
import { CreateWorldPage } from "./pages/CreateWorldPage";
import { CreateWorldBackground } from "./pages/CreateWorldBackground";
import { StartScreen, START_SCREEN_SKIP_ONCE_KEY } from "./pages/StartScreen";
import type { SimulationEvent, DialogueEventData, WorldTimeInfo } from "../types/api";
import { apiClient } from "./services/api-client";
import type { GeneratedWorldSummary, TickProgressInfo, WorldInfo } from "./services/api-client";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5000,
      refetchOnWindowFocus: false,
    },
  },
});

const DEFAULT_TOP_BAR_HEIGHT = 76;

type PlaybackProgressInfo = {
  label: string;
  at: number;
  eventId?: string;
  durationMs?: number;
};

function prependUniqueEvents(
  prev: SimulationEvent[],
  incoming: SimulationEvent[],
  limit = 50,
): SimulationEvent[] {
  const seen = new Set<string>();
  const next: SimulationEvent[] = [];
  for (const event of [...incoming, ...prev]) {
    if (event.id && seen.has(event.id)) continue;
    if (event.id) seen.add(event.id);
    next.push(event);
    if (next.length >= limit) break;
  }
  return next;
}

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

class PanelErrorBoundary extends Component<
  { children: ReactNode; label: string; resetKey: string },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn(`[${this.props.label}]`, error, info);
  }
  componentDidUpdate(prevProps: { resetKey: string }) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
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
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const backgroundRoot =
    typeof document === "undefined" ? null : document.getElementById("background-root");
  const isDevMode = new URLSearchParams(location.search).get("dev") === "1";
  const isCreateRoute = location.pathname === "/create";
  const isOverlayRoute =
    location.pathname === "/timeline";
  const [startScreenDismissed, setStartScreenDismissed] = useState(() => {
    if (typeof sessionStorage === "undefined") return false;
    const shouldSkip = sessionStorage.getItem(START_SCREEN_SKIP_ONCE_KEY) === "1";
    if (shouldSkip) sessionStorage.removeItem(START_SCREEN_SKIP_ONCE_KEY);
    return shouldSkip;
  });
  const [worldsList, setWorldsList] = useState<GeneratedWorldSummary[] | null>(null);
  const [hasUserWorlds, setHasUserWorlds] = useState(false);
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
  const [isResetting, setIsResetting] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayProgress, setReplayProgress] = useState<{ current: number; total: number } | null>(null);
  const [dialogueEvents, setDialogueEvents] = useState<SimulationEvent[]>([]);
  const [tickProgress, setTickProgress] = useState<TickProgressInfo[]>([]);
  const [playbackProgress, setPlaybackProgress] = useState<PlaybackProgressInfo | null>(null);
  const [runtimeStateRefreshNonce, setRuntimeStateRefreshNonce] = useState(0);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [transitionPhase, setTransitionPhase] = useState<"hidden" | "ending" | "starting" | "fade-out">("hidden");
  const [lastKnownDay, setLastKnownDay] = useState(0);
  const [topBarHeight, setTopBarHeight] = useState(DEFAULT_TOP_BAR_HEIGHT);
  const [showWalkableOverlay, setShowWalkableOverlay] = useState(false);
  const [showRegionBoundsOverlay, setShowRegionBoundsOverlay] = useState(false);
  const [showMainAreaPointsOverlay, setShowMainAreaPointsOverlay] = useState(false);
  const [showInteractiveObjectsOverlay, setShowInteractiveObjectsOverlay] = useState(false);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [possessionOpen, setPossessionOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(
    () => (typeof window === "undefined" ? 1200 : window.innerWidth),
  );
  const playbackProgressClearTimerRef = useRef<number | null>(null);
  const showStartScreen =
    !isCreateRoute &&
    !isOverlayRoute &&
    !startScreenDismissed &&
    worldsList !== null &&
    worldsList.length > 0;
  const waitingForStartScreenDecision =
    !isCreateRoute &&
    !isOverlayRoute &&
    !startScreenDismissed &&
    worldsList === null;
  const hideMainChrome = isOverlayRoute || isCreateRoute || showStartScreen || waitingForStartScreenDecision;
  const ticksPerScene = worldInfo?.sceneRuntime.cycleTicks ?? 48;
  const showDayTransition = worldInfo?.sceneRuntime.transitionEnabled ?? false;
  const endTransitionTitle =
    worldInfo?.sceneConfig.multiDay.endOfDayText || t("app.defaultEndTransition");
  const startTransitionTitle =
    worldInfo?.sceneConfig.multiDay.newDayText ||
    (worldInfo?.sceneConfig.sceneType === "open" ? t("app.defaultStartTransitionOpen") : t("app.defaultStartTransitionClosed"));
  const statePanelRightOffset = sidePanelOpen && viewportWidth >= 900 ? 424 : 14;

  useEffect(() => {
    eventBus.emit("set_cycle_ticks", ticksPerScene);
  }, [ticksPerScene, eventBus]);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const hudSafeTop = hideMainChrome
      ? 0
      : Math.max(topBarHeight + 16, DEFAULT_TOP_BAR_HEIGHT);
    document.documentElement.style.setProperty("--top-ui-offset", "0px");
    document.documentElement.style.setProperty("--hud-safe-top", `${hudSafeTop}px`);

    const rafId = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [hideMainChrome, topBarHeight]);

  // Hide Phaser canvas / labels on routes that fully take over the screen
  // (e.g. the create-world page). Phaser keeps running but is visually muted.
  useEffect(() => {
    const gameRoot = document.getElementById("game-root");
    const labelRoot = document.getElementById("label-root");
    const hidden = isCreateRoute;
    // Keep layout dimensions intact while hiding the roots. Phaser's RESIZE mode
    // can emit framebuffer errors if we force a resize while the parent is display:none.
    if (gameRoot) {
      gameRoot.style.visibility = hidden ? "hidden" : "";
      gameRoot.style.opacity = hidden ? "0" : "";
    }
    if (labelRoot) {
      labelRoot.style.visibility = hidden ? "hidden" : "";
      labelRoot.style.opacity = hidden ? "0" : "";
    }
    return () => {
      if (gameRoot) {
        gameRoot.style.visibility = "";
        gameRoot.style.opacity = "";
      }
      if (labelRoot) {
        labelRoot.style.visibility = "";
        labelRoot.style.opacity = "";
      }
    };
  }, [isCreateRoute]);

  // Load the list of generated worlds once so we can auto-redirect to /create
  // when the install is empty.
  useEffect(() => {
    let cancelled = false;
    apiClient.getGeneratedWorlds()
      .then((response) => {
        if (cancelled) return;
        const all = [...response.worlds, ...(response.libraryWorlds ?? [])];
        setWorldsList(all);
        setHasUserWorlds(response.worlds.length > 0);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn("[App] Failed to load generated worlds list:", error);
        setWorldsList([]);
        setHasUserWorlds(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let closed = false;

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message?.type !== "tick_progress") return;
          const progress = message.data as TickProgressInfo;
          setTickProgress((prev) => [progress, ...prev].slice(0, 6));
          if (progress.phase === "world_state_update_done") {
            setRuntimeStateRefreshNonce((prev) => prev + 1);
            if (progress.events?.length) {
              setEvents((prev) => prependUniqueEvents(prev, progress.events ?? []));
            }
          }
          eventBus.emit("tick_progress", progress);
          if (progress.phase === "tick_persisted" || progress.phase === "world_state_update_done") {
            window.setTimeout(() => {
              setTickProgress((prev) =>
                prev[0]?.at === progress.at ? [] : prev,
              );
            }, 3500);
          }
        } catch (error) {
          console.warn("[App] Failed to handle websocket message:", error);
        }
      };
      socket.onclose = () => {
        if (closed) return;
        reconnectTimer = window.setTimeout(connect, 1500);
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [eventBus]);

  useEffect(() => {
    if (worldsList === null) return;
    if (worldsList.length === 0 && !isCreateRoute) {
      navigate("/create", { replace: true });
    }
  }, [worldsList, isCreateRoute, navigate]);

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
    if (lastKnownDay === 0) {
      if (gameTime.day > 0) setLastKnownDay(gameTime.day);
      return;
    }

    if (!showDayTransition) {
      if (transitionPhase !== "hidden") setTransitionPhase("hidden");
      if (lastKnownDay !== gameTime.day) {
        setLastKnownDay(gameTime.day);
        eventBus.emit("scene_sync_characters");
      }
      return;
    }

    if (gameTime.day > lastKnownDay) {
      setLastKnownDay(gameTime.day);
      setTransitionPhase("starting");
      eventBus.emit("scene_sync_characters");
      
      setTimeout(() => {
        setTransitionPhase("fade-out");
        setTimeout(() => setTransitionPhase("hidden"), 1500);
      }, 3000);
    } else if (gameTime.day < lastKnownDay) {
      setLastKnownDay(gameTime.day);
    }
  }, [gameTime.day, lastKnownDay, showDayTransition, transitionPhase, eventBus]);

  useEffect(() => {
    const onSceneEnding = () => {
      setTransitionPhase("ending");
    };
    eventBus.on("scene_ending", onSceneEnding);
    return () => {
      eventBus.off("scene_ending", onSceneEnding);
    };
  }, [eventBus]);

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

  // Auto-enter replay mode when ?mode=replay is in the URL
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("mode") !== "replay") return;
    const timelineId = worldInfo?.currentTimelineId;
    if (!timelineId) return;
    const timer = setTimeout(() => {
      eventBus.emit("start_replay", timelineId);
    }, 600);
    return () => clearTimeout(timer);
  }, [worldInfo?.currentTimelineId, location.search, eventBus]);

  useEffect(() => {
    const onTimeUpdate = (time: WorldTimeInfo) => setGameTime(time);
    const onCharClick = (id: string) => setSelectedCharId(id);
    const onSimEvent = (event: SimulationEvent) => {
      setEvents((prev) => prependUniqueEvents(prev, [event]));
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
    const onPlaybackState = (payload: { autoPlay?: boolean }) => {
      if (payload.autoPlay != null) setAutoPlayEnabled(payload.autoPlay);
    };
    const onReplayMode = (payload: { active: boolean }) => {
      setIsReplaying(payload.active);
      if (!payload.active) setReplayProgress(null);
    };
    const onReplayProgress = (payload: { current: number; total: number }) => {
      setReplayProgress(payload);
    };
    const onReplayFinished = () => {
      setIsReplaying(false);
    };
    const onPlaybackProgress = (payload: PlaybackProgressInfo) => {
      setPlaybackProgress(payload);
      if (playbackProgressClearTimerRef.current != null) {
        window.clearTimeout(playbackProgressClearTimerRef.current);
      }
      playbackProgressClearTimerRef.current = window.setTimeout(() => {
        setPlaybackProgress((current) => current?.at === payload.at ? null : current);
        playbackProgressClearTimerRef.current = null;
      }, Math.max(1200, payload.durationMs ?? 3000));
    };

    eventBus.on("time_update", onTimeUpdate);
    eventBus.on("character_clicked", onCharClick);
    eventBus.on("sim_event", onSimEvent);
    eventBus.on("simulation_status", onSimStatus);
    eventBus.on("dialogue", onDialogue);
    eventBus.on("playback_state", onPlaybackState);
    eventBus.on("set_replay_mode", onReplayMode);
    eventBus.on("replay_progress", onReplayProgress);
    eventBus.on("replay_finished", onReplayFinished);
    eventBus.on("playback_progress", onPlaybackProgress);

    return () => {
      if (playbackProgressClearTimerRef.current != null) {
        window.clearTimeout(playbackProgressClearTimerRef.current);
        playbackProgressClearTimerRef.current = null;
      }
      eventBus.off("time_update", onTimeUpdate);
      eventBus.off("character_clicked", onCharClick);
      eventBus.off("sim_event", onSimEvent);
      eventBus.off("simulation_status", onSimStatus);
      eventBus.off("dialogue", onDialogue);
      eventBus.off("playback_state", onPlaybackState);
      eventBus.off("set_replay_mode", onReplayMode);
      eventBus.off("replay_progress", onReplayProgress);
      eventBus.off("replay_finished", onReplayFinished);
      eventBus.off("playback_progress", onPlaybackProgress);
    };
  }, [eventBus]);


  const handleToggleDevMode = useCallback(() => {
    const params = new URLSearchParams(location.search);
    if (isDevMode) {
      params.delete("dev");
    } else {
      params.set("dev", "1");
    }
    const newSearch = params.toString();
    navigate(`${location.pathname}${newSearch ? `?${newSearch}` : ""}`, { replace: true });
  }, [isDevMode, location.pathname, location.search, navigate]);

  const handleToggleAutoPlay = useCallback(() => {
    eventBus.emit("set_auto_play", !autoPlayEnabled);
  }, [autoPlayEnabled, eventBus]);

  const handleEnterFromStartScreen = useCallback(() => {
    setStartScreenDismissed(true);
  }, []);

  const handleNewTimeline = useCallback(async () => {
    const confirmed = window.confirm(t("app.confirmNewTimeline"));
    if (!confirmed) return;

    setIsResetting(true);
    try {
      await apiClient.createNewTimeline();
      window.location.reload();
    } catch (error) {
      console.warn("[App] Failed to create new timeline:", error);
      window.alert(t("app.failedPrefix", { error: error instanceof Error ? error.message : String(error) }));
      setIsResetting(false);
    }
  }, [t]);

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
    location.pathname === "/timeline" ? (
      <Timeline />
    ) : null;

  const overlay = overlayContent ? (
    <OverlayErrorBoundary key={location.pathname} onError={handleOverlayError}>
      {overlayContent}
    </OverlayErrorBoundary>
  ) : null;

  if (isCreateRoute) {
    return (
      <div style={{ width: "100%", height: "100%", pointerEvents: "auto" }}>
        {backgroundRoot &&
          createPortal(<CreateWorldBackground intensity="calm" />, backgroundRoot)}
        <CreateWorldPage hasExistingWorlds={hasUserWorlds} />
      </div>
    );
  }

  return (
    <>
      {backgroundRoot &&
        createPortal(<CreateWorldBackground intensity="calm" />, backgroundRoot)}
      <div style={{ width: "100%", height: "100%", pointerEvents: "none" }}>
        {showStartScreen && (
          <StartScreen
            worldInfo={worldInfo}
            gameTime={gameTime}
            onEnterCurrent={handleEnterFromStartScreen}
            onCreateWorld={() => navigate("/create")}
          />
        )}
        {!hideMainChrome && (
        <>
          <TopBar
            worldInfo={worldInfo}
            gameTime={gameTime}
            isDevMode={isDevMode}
            onToggleDevMode={handleToggleDevMode}
            showWalkableOverlay={showWalkableOverlay}
            showRegionBoundsOverlay={showRegionBoundsOverlay}
            showMainAreaPointsOverlay={showMainAreaPointsOverlay}
            showInteractiveObjectsOverlay={showInteractiveObjectsOverlay}
            onToggleWalkableOverlay={() => setShowWalkableOverlay((prev) => !prev)}
            onToggleRegionBoundsOverlay={() => setShowRegionBoundsOverlay((prev) => !prev)}
            onToggleMainAreaPointsOverlay={() => setShowMainAreaPointsOverlay((prev) => !prev)}
            onToggleInteractiveObjectsOverlay={() => setShowInteractiveObjectsOverlay((prev) => !prev)}
            onToggleAutoPlay={handleToggleAutoPlay}
            onNewTimeline={handleNewTimeline}
            simStatus={simStatus}
            autoPlayEnabled={autoPlayEnabled}
            isResetting={isResetting}
            isReplaying={isReplaying}
            replayProgress={replayProgress}
            tickProgress={tickProgress}
            playbackProgress={playbackProgress}
            onHeightChange={setTopBarHeight}
            onOpenPossession={() => setPossessionOpen(true)}
          />
          {worldInfo && (worldInfo.originalPrompt?.trim() || worldInfo.worldDescription?.trim()) && (
            <WorldIntroBanner
              worldKey={worldInfo.currentWorldId || worldInfo.worldName}
              worldName={worldInfo.worldName}
              worldDescription={worldInfo.originalPrompt?.trim() || worldInfo.worldDescription}
              hasRun={(worldInfo.timelineTickCount ?? 0) > 0}
              topOffset={Math.max(topBarHeight + 16, DEFAULT_TOP_BAR_HEIGHT)}
            />
          )}
          <SidePanel
            selectedCharId={selectedCharId}
            followedCharId={followedCharId}
            onSelect={setSelectedCharId}
            onToggleFollow={handleToggleFollowChar}
            events={events}
            onOpenChange={setSidePanelOpen}
          />
          <PanelErrorBoundary
            label="DialoguePanel"
            resetKey={`${dialogueEvents.length}:${dialogueEvents[dialogueEvents.length - 1]?.id ?? ""}`}
          >
            <DialoguePanel
              events={dialogueEvents.filter(
                (e) => {
                  const d = e.data as DialogueEventData | undefined;
                  return d?.conversationId && !dismissedIds.has(d.conversationId);
                }
              )}
              ticksPerScene={ticksPerScene}
              onDismiss={(id) => setDismissedIds((prev) => new Set(prev).add(id))}
            />
          </PanelErrorBoundary>
          <MapControls eventBus={eventBus} />
          <RuntimeStatePanel
            visible={isDevMode}
            rightOffset={statePanelRightOffset}
            refreshKey={`${gameTime.day}:${gameTime.tick}:${runtimeStateRefreshNonce}:${events[0]?.id ?? ""}:${worldInfo?.currentTimelineId ?? ""}`}
          />
          {possessionOpen && (
            <PossessionPanel
              initialCharacterId={selectedCharId ?? followedCharId}
              eventBus={eventBus}
              onClose={() => setPossessionOpen(false)}
            />
          )}
          <SceneTransition
            day={gameTime.day + (transitionPhase === "ending" ? 1 : 0)}
            phase={transitionPhase}
            title={transitionPhase === "ending" ? endTransitionTitle : startTransitionTitle}
            timeString={transitionPhase === "ending" ? "" : (gameTime.timeString || worldInfo?.sceneConfig.multiDay.nextDayStartTime)}
            periodLabel={transitionPhase === "ending" ? "" : gameTime.period}
            variant={worldInfo?.sceneConfig.sceneType === "open" ? "open" : "closed"}
            onCovered={() => eventBus.emit("scene_covered")}
          />
        </>
        )}
        {overlay}
      </div>
    </>
  );
}
