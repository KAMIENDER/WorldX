import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { TimelineMeta, TimelineWithWorld, WorldTimeInfo } from "../../types/api";
import { apiClient } from "../services/api-client";
import type { WorldInfo } from "../services/api-client";
import { translatePeriod } from "../utils/time-i18n";

export const START_SCREEN_SKIP_ONCE_KEY = "worldx.startScreenSkipOnce";

type StartMode = "home" | "load" | "newTimeline";
type MenuTone = "gold" | "blue" | "paper" | "green";

type TimelineOption = {
  world: TimelineWithWorld;
  timeline: TimelineMeta;
  key: string;
};

type StartScreenProps = {
  worldInfo?: WorldInfo | null;
  gameTime: WorldTimeInfo;
  onEnterCurrent: () => void;
  onCreateWorld: () => void;
};

function makeTimelineKey(worldId: string, timelineId: string): string {
  return `${worldId}::${timelineId}`;
}

function formatDateTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale.startsWith("zh") ? "zh-CN" : "en", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getTimelineTitle(timeline: TimelineMeta, t: (key: string, params?: Record<string, unknown>) => string): string {
  const explicitName = timeline.name?.trim();
  if (explicitName) return explicitName;
  if (timeline.saveKind === "manual") return t("start.manualFallback");
  return t("start.timelineFallback");
}

function skipStartOnce() {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(START_SCREEN_SKIP_ONCE_KEY, "1");
}

export function StartScreen({
  worldInfo,
  gameTime,
  onEnterCurrent,
  onCreateWorld,
}: StartScreenProps) {
  const { t, i18n } = useTranslation();
  const [introStarted, setIntroStarted] = useState(false);
  const [mode, setMode] = useState<StartMode>("home");
  const [groups, setGroups] = useState<TimelineWithWorld[]>([]);
  const [currentTimelineId, setCurrentTimelineId] = useState<string | null>(null);
  const [selectedTimelineKey, setSelectedTimelineKey] = useState("");
  const [selectedWorldId, setSelectedWorldId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"load" | "newTimeline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locale = i18n.resolvedLanguage || i18n.language || "zh";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiClient.getAllTimelinesGrouped()
      .then((response) => {
        if (cancelled) return;
        setGroups(response.groups);
        setCurrentTimelineId(response.currentTimelineId);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const timelineOptions = useMemo<TimelineOption[]>(
    () =>
      groups
        .flatMap((world) =>
          world.timelines.map((timeline) => ({
            world,
            timeline,
            key: makeTimelineKey(world.worldId, timeline.id),
          })),
        )
        .sort((a, b) => Date.parse(b.timeline.updatedAt) - Date.parse(a.timeline.updatedAt)),
    [groups],
  );

  const displayGroups = useMemo(
    () =>
      [...groups].sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        if ((a.source === "library") !== (b.source === "library")) {
          return a.source === "library" ? 1 : -1;
        }
        return a.worldName.localeCompare(b.worldName, locale.startsWith("zh") ? "zh-CN" : "en");
      }),
    [groups, locale],
  );

  useEffect(() => {
    if (loading) return;

    setSelectedTimelineKey((prev) => {
      if (prev && timelineOptions.some((option) => option.key === prev)) return prev;
      const current = timelineOptions.find((option) => option.timeline.id === currentTimelineId);
      return (current ?? timelineOptions[0])?.key ?? "";
    });

    setSelectedWorldId((prev) => {
      if (prev && groups.some((group) => group.worldId === prev)) return prev;
      const currentWorldId = worldInfo?.currentWorldId;
      const current = currentWorldId ? groups.find((group) => group.worldId === currentWorldId) : null;
      return (current ?? groups.find((group) => group.isCurrent) ?? groups[0])?.worldId ?? "";
    });
  }, [currentTimelineId, groups, loading, timelineOptions, worldInfo?.currentWorldId]);

  const selectedTimeline = timelineOptions.find((option) => option.key === selectedTimelineKey) ?? null;
  const selectedWorld = groups.find((group) => group.worldId === selectedWorldId) ?? null;
  const currentWorldName = worldInfo?.worldName ?? t("start.loadingWorld");
  const currentPeriod = translatePeriod(gameTime.period);
  const isBusy = busy !== null;
  const totalWorldCount = groups.length;
  const totalTimelineCount = timelineOptions.length;
  const featuredWorlds = displayGroups.slice(0, 4);

  const handleEnterCurrent = () => {
    onEnterCurrent();
  };

  const handleOpenMenu = () => {
    setIntroStarted(true);
  };

  const handleLoadSelected = async () => {
    if (!selectedTimeline || isBusy) return;
    setBusy("load");
    setError(null);
    try {
      if (selectedTimeline.timeline.id === currentTimelineId) {
        handleEnterCurrent();
        return;
      }
      await apiClient.loadTimelineFromWorld(selectedTimeline.world.worldId, selectedTimeline.timeline.id);
      skipStartOnce();
      window.location.reload();
    } catch (err) {
      setError(t("start.failed", { error: err instanceof Error ? err.message : String(err) }));
      setBusy(null);
    }
  };

  const handleStartNewTimeline = async () => {
    if (!selectedWorld || isBusy) return;
    setBusy("newTimeline");
    setError(null);
    try {
      if (selectedWorld.worldId !== worldInfo?.currentWorldId) {
        await apiClient.switchWorld(selectedWorld.worldId);
      }
      await apiClient.createNewTimeline();
      skipStartOnce();
      window.location.reload();
    } catch (err) {
      setError(t("start.failed", { error: err instanceof Error ? err.message : String(err) }));
      setBusy(null);
    }
  };

  const menuItems: Array<{
    key: string;
    index: string;
    title: string;
    hint: string;
    tone: MenuTone;
    onClick: () => void;
  }> = [
    {
      key: "continue",
      index: "01",
      title: t("start.startGame"),
      hint: t("start.startGameHint"),
      tone: "gold",
      onClick: handleEnterCurrent,
    },
    {
      key: "archive",
      index: "02",
      title: t("start.loadTab"),
      hint: t("start.loadMenuHint"),
      tone: "blue",
      onClick: () => setMode("load"),
    },
    {
      key: "branch",
      index: "03",
      title: t("start.newTimelineTab"),
      hint: t("start.newTimelineMenuHint"),
      tone: "green",
      onClick: () => setMode("newTimeline"),
    },
    {
      key: "create",
      index: "04",
      title: t("start.createWorld"),
      hint: t("start.createWorldHint"),
      tone: "paper",
      onClick: onCreateWorld,
    },
  ];

  return (
    <div style={overlayStyle}>
      <div style={scanlineStyle} />
      <section style={!introStarted && mode === "home" ? introStageStyle : stageStyle}>
        {!introStarted && mode === "home" ? (
          <main style={introScreenStyle}>
            <div style={introBrandStyle}>
              <div style={brandMarkStyle}>界</div>
              <div>
                <div style={brandLabelStyle}>{t("start.eyebrow")}</div>
                <div style={brandTitleStyle}>{t("start.brand")}</div>
              </div>
            </div>

            <section style={introTitleWrapStyle}>
              <div style={introKickerStyle}>{t("start.introKicker")}</div>
              <h1 style={introTitleStyle}>{t("start.introTitle")}</h1>
              <p style={introSubtitleStyle}>{t("start.introSubtitle")}</p>
              <button type="button" onClick={handleOpenMenu} style={pressStartStyle}>
                {t("start.pressStart")}
              </button>
            </section>

            <div style={introAnchorStyle}>
              <span style={anchorLabelStyle}>{t("start.currentWorld")}</span>
              <span style={introWorldNameStyle}>{currentWorldName}</span>
              <span style={anchorTimeStyle}>
                {t("start.currentTime", {
                  day: gameTime.day,
                  time: gameTime.timeString,
                  period: currentPeriod,
                })}
              </span>
            </div>
          </main>
        ) : (
          <>
            <header style={topLineStyle}>
              <div style={brandLockupStyle}>
                <div style={brandMarkStyle}>界</div>
                <div>
                  <div style={brandLabelStyle}>{t("start.eyebrow")}</div>
                  <div style={brandTitleStyle}>{t("start.brand")}</div>
                </div>
              </div>
              <div style={topStatsStyle}>
                <span style={topStatStyle}>{loading ? t("start.loading") : t("start.worldCountCompact", { count: totalWorldCount })}</span>
                <span style={topStatStyle}>{loading ? "--" : t("start.timelineCountCompact", { count: totalTimelineCount })}</span>
              </div>
            </header>

            {mode === "home" ? (
          <main style={homeStageStyle}>
            <section style={titleStageStyle}>
              <div style={chapterLabelStyle}>{t("start.title")}</div>
              <h1 style={landingTitleStyle}>{t("start.homeTitle")}</h1>
              <p style={landingCopyStyle}>{t("start.subtitle")}</p>
              <div style={currentAnchorStyle}>
                <span style={anchorLabelStyle}>{t("start.currentWorld")}</span>
                <span style={anchorWorldStyle}>{currentWorldName}</span>
                <span style={anchorTimeStyle}>
                  {t("start.currentTime", {
                    day: gameTime.day,
                    time: gameTime.timeString,
                    period: currentPeriod,
                  })}
                </span>
              </div>
            </section>

            <nav style={commandMenuStyle} aria-label={t("start.menuLabel")}>
              {menuItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={item.onClick}
                  style={commandItemStyle(item.tone)}
                >
                  <span style={commandIndexStyle(item.tone)}>{item.index}</span>
                  <span style={commandTextStyle}>
                    <span style={commandTitleStyle}>{item.title}</span>
                    <span style={commandHintStyle}>{item.hint}</span>
                  </span>
                  <span style={commandArrowStyle}>›</span>
                </button>
              ))}
            </nav>

            <section style={worldShelfStyle}>
              <div style={shelfHeaderStyle}>
                <span>{t("start.worldShelf")}</span>
                <span style={shelfMetaStyle}>{t("start.heroHint")}</span>
              </div>
              <div style={worldDeckStyle}>
                {loading ? (
                  <div style={deckEmptyStyle}>{t("start.loading")}</div>
                ) : featuredWorlds.length === 0 ? (
                  <div style={deckEmptyStyle}>{t("start.emptyWorlds")}</div>
                ) : (
                  featuredWorlds.map((group, index) => (
                    <div
                      key={group.worldId}
                      style={deckCardStyle(group.worldId === worldInfo?.currentWorldId || group.isCurrent)}
                    >
                      <span style={deckSlotStyle}>{t("start.slotIndex", { index: index + 1 })}</span>
                      <span style={deckWorldNameStyle}>{group.worldName}</span>
                      <span style={deckMetaStyle}>
                        {group.source === "library" ? t("start.sampleWorld") : t("start.myWorld")}
                        {" · "}
                        {t("start.worldTimelineCount", { count: group.timelines.length })}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>

            {error && <div style={floatingErrorStyle}>{error}</div>}
          </main>
            ) : (
          <main style={archiveStageStyle}>
            <aside style={archiveIntroStyle}>
              <button type="button" onClick={() => setMode("home")} style={backButtonStyle}>
                {t("start.backToMenu")}
              </button>
              <div style={chapterLabelStyle}>{t("start.chooseTitle")}</div>
              <h1 style={archiveTitleStyle}>
                {mode === "load" ? t("start.loadTitle") : t("start.newTimelineTitle")}
              </h1>
              <p style={archiveCopyStyle}>
                {mode === "load" ? t("start.loadHint") : t("start.newTimelineHint")}
              </p>
              <div style={archiveModeSwitchStyle}>
                <button
                  type="button"
                  aria-pressed={mode === "load"}
                  onClick={() => setMode("load")}
                  style={modeButtonStyle(mode === "load")}
                >
                  {t("start.loadTab")}
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "newTimeline"}
                  onClick={() => setMode("newTimeline")}
                  style={modeButtonStyle(mode === "newTimeline")}
                >
                  {t("start.newTimelineTab")}
                </button>
              </div>
            </aside>

            <section style={archiveDrawerStyle}>
              <div style={drawerHeaderStyle}>
                <div>
                  <div style={drawerKickerStyle}>{t("start.archiveLabel")}</div>
                  <div style={drawerTitleStyle}>
                    {mode === "load" ? t("start.loadTab") : t("start.newTimelineTab")}
                  </div>
                </div>
                <button type="button" onClick={onCreateWorld} style={subtleButtonStyle(false)} title={t("start.createWorldHint")}>
                  {t("start.createWorld")}
                </button>
              </div>

              {loading ? (
                <div style={emptyStyle}>{t("start.loading")}</div>
              ) : mode === "load" ? (
                timelineOptions.length === 0 ? (
                  <div style={emptyStyle}>{t("start.emptySaves")}</div>
                ) : (
                  <div className="custom-scrollbar" style={listStyle}>
                    {displayGroups.map((group) => {
                      const hasTimelines = group.timelines.length > 0;
                      return (
                        <div key={group.worldId} style={worldSectionStyle}>
                          <div style={worldSectionHeaderStyle}>
                            <span style={worldNameStyle}>{group.worldName}</span>
                            <span style={smallMetaStyle}>
                              {hasTimelines
                                ? t("start.worldTimelineCount", { count: group.timelines.length })
                                : t("start.noTimeline")}
                            </span>
                          </div>
                          {group.timelines.map((timeline) => {
                            const key = makeTimelineKey(group.worldId, timeline.id);
                            return (
                              <button
                                type="button"
                                key={key}
                                onClick={() => setSelectedTimelineKey(key)}
                                style={timelineRowStyle(selectedTimelineKey === key)}
                              >
                                <span style={rowMainStyle}>
                                  <span style={rowTitleStyle}>
                                    {getTimelineTitle(timeline, t)}
                                    {timeline.id === currentTimelineId && (
                                      <span style={activeBadgeStyle}>{t("start.current")}</span>
                                    )}
                                  </span>
                                  <span style={rowMetaStyle}>
                                    {t("start.timelineMeta", {
                                      day: timeline.lastGameTime.day,
                                      tick: timeline.tickCount,
                                    })}
                                    {" · "}
                                    {t("start.updatedAt", { date: formatDateTime(timeline.updatedAt, locale) })}
                                  </span>
                                </span>
                                <span style={kindBadgeStyle(timeline.saveKind === "manual")}>
                                  {timeline.saveKind === "manual" ? t("start.manualSave") : t("start.autoSave")}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )
              ) : groups.length === 0 ? (
                <div style={emptyStyle}>{t("start.emptyWorlds")}</div>
              ) : (
                <div className="custom-scrollbar" style={listStyle}>
                  {displayGroups.map((group) => (
                    <button
                      type="button"
                      key={group.worldId}
                      onClick={() => setSelectedWorldId(group.worldId)}
                      style={worldRowStyle(selectedWorldId === group.worldId)}
                    >
                      <span style={rowMainStyle}>
                        <span style={rowTitleStyle}>
                          {group.worldName}
                          {group.isCurrent && <span style={activeBadgeStyle}>{t("start.current")}</span>}
                        </span>
                        <span style={rowMetaStyle}>
                          {group.source === "library" ? t("start.sampleWorld") : t("start.myWorld")}
                          {" · "}
                          {t("start.worldTimelineCount", { count: group.timelines.length })}
                        </span>
                      </span>
                      <span style={selectedWorldId === group.worldId ? selectedBadgeStyle : ghostBadgeStyle}>
                        {selectedWorldId === group.worldId ? t("start.selected") : group.worldId.slice(0, 8)}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {error && <div style={errorStyle}>{error}</div>}

              <footer style={footerStyle}>
                {mode === "load" ? (
                  <button
                    type="button"
                    onClick={handleLoadSelected}
                    disabled={!selectedTimeline || isBusy}
                    style={primaryButtonStyle(!selectedTimeline || isBusy)}
                  >
                    {busy === "load" ? t("start.loadingSelected") : t("start.loadSelected")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleStartNewTimeline}
                    disabled={!selectedWorld || isBusy}
                    style={primaryButtonStyle(!selectedWorld || isBusy)}
                  >
                    {busy === "newTimeline" ? t("start.startingNewTimeline") : t("start.startNewTimeline")}
                  </button>
                )}
              </footer>
            </section>
          </main>
            )}
          </>
        )}
      </section>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 60,
  pointerEvents: "auto",
  overflow: "auto",
  display: "flex",
  alignItems: "stretch",
  justifyContent: "center",
  padding: 28,
  backgroundImage:
    "radial-gradient(circle at 76% 18%, rgba(68,216,255,0.18), transparent 28%), radial-gradient(circle at 18% 72%, rgba(255,216,77,0.2), transparent 30%), linear-gradient(100deg, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0.18) 45%, rgba(0,0,0,0.8) 100%), linear-gradient(180deg, rgba(0,0,0,0.12), rgba(0,0,0,0.72)), url('/assets/start-worlds-hub.jpg')",
  backgroundSize: "cover",
  backgroundPosition: "center",
  backgroundColor: "#050505",
};

const scanlineStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  pointerEvents: "none",
  opacity: 0.28,
  backgroundImage:
    "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, transparent, rgba(255,216,77,0.08), transparent)",
  backgroundSize: "100% 7px, 100% 100%",
  mixBlendMode: "overlay",
};

const introStageStyle: CSSProperties = {
  position: "relative",
  width: "min(1360px, 100%)",
  minHeight: "min(820px, calc(100vh - 56px))",
  color: "var(--hud-text)",
  overflow: "hidden",
};

const introScreenStyle: CSSProperties = {
  minHeight: "min(820px, calc(100vh - 56px))",
  display: "grid",
  gridTemplateRows: "auto 1fr auto",
  gap: 22,
  padding: "22px 24px",
  textShadow: "0 5px 22px rgba(0,0,0,0.84)",
};

const introBrandStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  width: "fit-content",
};

const introTitleWrapStyle: CSSProperties = {
  alignSelf: "center",
  justifySelf: "center",
  display: "grid",
  justifyItems: "center",
  textAlign: "center",
  maxWidth: 820,
};

const introKickerStyle: CSSProperties = {
  padding: "6px 10px",
  color: "var(--hud-ink)",
  background: "var(--hud-gold)",
  fontSize: 12,
  fontWeight: 950,
  clipPath: "var(--hud-cut-corners)",
  boxShadow: "4px 4px 0 rgba(0,0,0,0.3)",
};

const introTitleStyle: CSSProperties = {
  margin: "18px 0 0",
  color: "var(--hud-text)",
  fontSize: 118,
  lineHeight: 0.9,
  fontWeight: 950,
  letterSpacing: 0,
  wordBreak: "break-word",
};

const introSubtitleStyle: CSSProperties = {
  maxWidth: 520,
  margin: "18px 0 0",
  color: "rgba(248,243,230,0.82)",
  fontSize: 18,
  lineHeight: 1.5,
  fontWeight: 850,
};

const pressStartStyle: CSSProperties = {
  minHeight: 56,
  marginTop: 34,
  padding: "0 34px",
  border: "0",
  background: "linear-gradient(90deg, var(--hud-gold), #fff0a2)",
  color: "var(--hud-ink)",
  fontSize: 18,
  fontWeight: 950,
  cursor: "pointer",
  clipPath: "var(--hud-cut-corners)",
  boxShadow: "7px 7px 0 rgba(0,0,0,0.34)",
};

const introAnchorStyle: CSSProperties = {
  justifySelf: "end",
  width: "min(360px, 100%)",
  display: "grid",
  gap: 5,
  padding: "12px 14px",
  background: "linear-gradient(90deg, rgba(0,0,0,0.64), rgba(0,0,0,0.28))",
  borderLeft: "5px solid var(--hud-blue)",
  clipPath: "var(--hud-cut-corners)",
};

const introWorldNameStyle: CSSProperties = {
  minWidth: 0,
  color: "var(--hud-paper)",
  fontSize: 20,
  lineHeight: 1.1,
  fontWeight: 950,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const stageStyle: CSSProperties = {
  position: "relative",
  width: "min(1360px, 100%)",
  minHeight: "min(820px, calc(100vh - 56px))",
  color: "var(--hud-text)",
  display: "flex",
  flexDirection: "column",
  gap: 24,
  padding: "22px 24px",
  border: "1px solid rgba(255,255,255,0.2)",
  boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.68), 0 30px 80px rgba(0,0,0,0.5)",
  background:
    "linear-gradient(180deg, rgba(0,0,0,0.12), rgba(0,0,0,0.34)), repeating-linear-gradient(135deg, rgba(255,255,255,0.04) 0 2px, transparent 2px 12px)",
  overflow: "hidden",
};

const topLineStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 18,
  flexWrap: "wrap",
};

const brandLockupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  textShadow: "0 4px 18px rgba(0,0,0,0.8)",
};

const brandMarkStyle: CSSProperties = {
  width: 58,
  height: 58,
  display: "grid",
  placeItems: "center",
  background: "var(--hud-gold)",
  color: "var(--hud-ink)",
  fontWeight: 950,
  fontSize: 32,
  lineHeight: 1,
  clipPath: "var(--hud-cut-corners)",
  boxShadow: "5px 5px 0 rgba(0,0,0,0.34)",
};

const brandLabelStyle: CSSProperties = {
  color: "var(--hud-blue)",
  fontSize: 11,
  fontWeight: 950,
  letterSpacing: 0,
  textTransform: "uppercase",
};

const brandTitleStyle: CSSProperties = {
  color: "var(--hud-text)",
  fontSize: 38,
  lineHeight: 1,
  fontWeight: 950,
  letterSpacing: 0,
};

const topStatsStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  justifyContent: "flex-end",
};

const topStatStyle: CSSProperties = {
  padding: "8px 11px",
  color: "var(--hud-paper)",
  background: "rgba(0,0,0,0.36)",
  border: "1px solid rgba(255,255,255,0.18)",
  fontSize: 12,
  fontWeight: 900,
  clipPath: "var(--hud-cut-corners)",
  textShadow: "0 2px 10px rgba(0,0,0,0.72)",
};

const homeStageStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))",
  gridTemplateRows: "1fr auto",
  gap: 22,
  alignItems: "end",
};

const titleStageStyle: CSSProperties = {
  alignSelf: "center",
  maxWidth: 720,
  textShadow: "0 5px 22px rgba(0,0,0,0.84)",
};

const chapterLabelStyle: CSSProperties = {
  width: "fit-content",
  padding: "6px 10px",
  color: "var(--hud-ink)",
  background: "var(--hud-gold)",
  fontSize: 12,
  fontWeight: 950,
  clipPath: "var(--hud-cut-corners)",
  boxShadow: "4px 4px 0 rgba(0,0,0,0.28)",
};

const landingTitleStyle: CSSProperties = {
  margin: "18px 0 0",
  color: "var(--hud-text)",
  fontSize: 88,
  lineHeight: 0.94,
  fontWeight: 950,
  letterSpacing: 0,
  wordBreak: "break-word",
};

const landingCopyStyle: CSSProperties = {
  maxWidth: 560,
  margin: "18px 0 0",
  color: "rgba(248,243,230,0.82)",
  fontSize: 18,
  lineHeight: 1.5,
  fontWeight: 800,
};

const currentAnchorStyle: CSSProperties = {
  width: "min(560px, 100%)",
  marginTop: 30,
  display: "grid",
  gap: 5,
  padding: "14px 16px",
  background: "linear-gradient(90deg, rgba(0,0,0,0.7), rgba(0,0,0,0.28))",
  borderLeft: "5px solid var(--hud-blue)",
  clipPath: "var(--hud-cut-corners)",
};

const anchorLabelStyle: CSSProperties = {
  color: "var(--hud-blue)",
  fontSize: 11,
  fontWeight: 950,
};

const anchorWorldStyle: CSSProperties = {
  minWidth: 0,
  color: "var(--hud-paper)",
  fontSize: 24,
  lineHeight: 1.1,
  fontWeight: 950,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const anchorTimeStyle: CSSProperties = {
  color: "var(--hud-muted)",
  fontSize: 13,
  fontWeight: 850,
};

const commandMenuStyle: CSSProperties = {
  alignSelf: "center",
  display: "grid",
  gap: 10,
};

const commandTextStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  textAlign: "left",
};

const commandTitleStyle: CSSProperties = {
  color: "inherit",
  fontSize: 24,
  lineHeight: 1.1,
  fontWeight: 950,
};

const commandHintStyle: CSSProperties = {
  color: "rgba(248,243,230,0.64)",
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 800,
};

const commandArrowStyle: CSSProperties = {
  marginLeft: "auto",
  color: "inherit",
  fontSize: 32,
  lineHeight: 1,
  fontWeight: 950,
};

const worldShelfStyle: CSSProperties = {
  gridColumn: "1 / -1",
  display: "grid",
  gap: 10,
  paddingTop: 10,
};

const shelfHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  color: "var(--hud-gold)",
  fontSize: 12,
  fontWeight: 950,
  textTransform: "uppercase",
  textShadow: "0 2px 12px rgba(0,0,0,0.8)",
};

const shelfMetaStyle: CSSProperties = {
  color: "var(--hud-muted)",
  fontSize: 11,
  fontWeight: 850,
  textTransform: "none",
  textAlign: "right",
};

const worldDeckStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 10,
};

const deckSlotStyle: CSSProperties = {
  color: "var(--hud-blue)",
  fontSize: 10,
  fontWeight: 950,
};

const deckWorldNameStyle: CSSProperties = {
  minWidth: 0,
  color: "var(--hud-paper)",
  fontSize: 17,
  lineHeight: 1.15,
  fontWeight: 950,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const deckMetaStyle: CSSProperties = {
  color: "var(--hud-muted)",
  fontSize: 11,
  fontWeight: 800,
};

const deckEmptyStyle: CSSProperties = {
  minHeight: 76,
  display: "grid",
  placeItems: "center",
  color: "var(--hud-muted)",
  background: "rgba(0,0,0,0.38)",
  border: "1px solid rgba(255,255,255,0.16)",
  fontSize: 13,
  fontWeight: 850,
  clipPath: "var(--hud-cut-corners)",
};

const errorStyleBase: CSSProperties = {
  padding: "10px 12px",
  color: "#ffbcc2",
  background: "rgba(255,79,94,0.12)",
  border: "1px solid rgba(255,79,94,0.38)",
  fontSize: 13,
  fontWeight: 800,
  clipPath: "var(--hud-cut-corners)",
};

const floatingErrorStyle: CSSProperties = {
  gridColumn: "1 / -1",
  ...errorStyleBase,
};

const archiveStageStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(360px, 100%), 1fr))",
  gap: 24,
  alignItems: "stretch",
};

const archiveIntroStyle: CSSProperties = {
  minHeight: 0,
  alignSelf: "center",
  display: "flex",
  flexDirection: "column",
  gap: 16,
  color: "var(--hud-text)",
  textShadow: "0 5px 22px rgba(0,0,0,0.84)",
};

const archiveTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--hud-text)",
  fontSize: 58,
  lineHeight: 0.98,
  fontWeight: 950,
  letterSpacing: 0,
  wordBreak: "break-word",
};

const archiveCopyStyle: CSSProperties = {
  maxWidth: 430,
  margin: 0,
  color: "rgba(248,243,230,0.78)",
  fontSize: 16,
  lineHeight: 1.55,
  fontWeight: 800,
};

const archiveModeSwitchStyle: CSSProperties = {
  display: "flex",
  gap: 9,
  flexWrap: "wrap",
};

const archiveDrawerStyle: CSSProperties = {
  minHeight: 0,
  height: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: 18,
  color: "var(--hud-text)",
  background: "linear-gradient(180deg, rgba(10,10,10,0.9), rgba(5,5,5,0.78)), var(--hud-stripe)",
  backdropFilter: "blur(9px)",
  borderLeft: "5px solid var(--hud-gold)",
  borderTop: "1px solid rgba(255,255,255,0.22)",
  borderRight: "1px solid rgba(255,255,255,0.16)",
  borderBottom: "1px solid rgba(255,255,255,0.16)",
  boxShadow: "0 24px 64px rgba(0,0,0,0.48), 6px 6px 0 rgba(0,0,0,0.24)",
  clipPath: "var(--hud-cut-corners)",
  overflow: "hidden",
};

const drawerHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
};

const drawerKickerStyle: CSSProperties = {
  color: "var(--hud-blue)",
  fontSize: 11,
  fontWeight: 950,
  textTransform: "uppercase",
};

const drawerTitleStyle: CSSProperties = {
  marginTop: 4,
  color: "var(--hud-text)",
  fontSize: 22,
  fontWeight: 950,
};

const backButtonStyle: CSSProperties = {
  width: "fit-content",
  minHeight: 38,
  padding: "0 13px",
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(0,0,0,0.38)",
  color: "var(--hud-paper)",
  fontSize: 13,
  fontWeight: 950,
  cursor: "pointer",
  clipPath: "var(--hud-cut-corners)",
};

const listStyle: CSSProperties = {
  minHeight: 0,
  flex: 1,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  paddingRight: 4,
};

const worldSectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const worldSectionHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 10,
  padding: "4px 2px",
};

const worldNameStyle: CSSProperties = {
  color: "var(--hud-gold)",
  fontSize: 13,
  fontWeight: 900,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const smallMetaStyle: CSSProperties = {
  color: "var(--hud-dim)",
  fontSize: 12,
  fontWeight: 750,
  whiteSpace: "nowrap",
};

const rowMainStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  textAlign: "left",
};

const rowTitleStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 8,
  color: "var(--hud-text)",
  fontSize: 15,
  fontWeight: 900,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const rowMetaStyle: CSSProperties = {
  color: "var(--hud-muted)",
  fontSize: 12,
  fontWeight: 700,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const activeBadgeStyle: CSSProperties = {
  flex: "0 0 auto",
  padding: "2px 6px",
  color: "var(--hud-ink)",
  background: "var(--hud-green)",
  fontSize: 10,
  fontWeight: 950,
  clipPath: "var(--hud-cut-corners)",
};

const selectedBadgeStyle: CSSProperties = {
  flex: "0 0 auto",
  padding: "5px 9px",
  color: "var(--hud-ink)",
  background: "var(--hud-gold)",
  fontSize: 11,
  fontWeight: 950,
  clipPath: "var(--hud-cut-corners)",
};

const ghostBadgeStyle: CSSProperties = {
  ...selectedBadgeStyle,
  color: "var(--hud-dim)",
  background: "rgba(255,255,255,0.08)",
};

const emptyStyle: CSSProperties = {
  minHeight: 160,
  display: "grid",
  placeItems: "center",
  color: "var(--hud-muted)",
  border: "1px dashed rgba(255,255,255,0.18)",
  fontSize: 14,
  fontWeight: 750,
  textAlign: "center",
  padding: 18,
  clipPath: "var(--hud-cut-corners)",
};

const errorStyle: CSSProperties = {
  ...errorStyleBase,
};

const footerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
};

function commandItemStyle(tone: MenuTone): CSSProperties {
  const accent =
    tone === "blue"
      ? "var(--hud-blue)"
      : tone === "green"
        ? "var(--hud-green)"
        : tone === "paper"
          ? "var(--hud-paper)"
          : "var(--hud-gold)";
  const border =
    tone === "blue"
      ? "1px solid rgba(68,216,255,0.54)"
      : tone === "green"
        ? "1px solid rgba(101,242,155,0.48)"
        : tone === "paper"
          ? "1px solid rgba(241,234,219,0.42)"
          : "0";
  const isPrimary = tone === "gold";
  return {
    width: "100%",
    minHeight: isPrimary ? 78 : 68,
    display: "grid",
    gridTemplateColumns: "42px minmax(0, 1fr) 26px",
    alignItems: "center",
    gap: 12,
    padding: "12px 14px",
    border,
    borderLeft: `6px solid ${accent}`,
    background: isPrimary
      ? "linear-gradient(90deg, var(--hud-gold), #fff0a2)"
      : "linear-gradient(90deg, rgba(0,0,0,0.74), rgba(0,0,0,0.38))",
    color: isPrimary ? "var(--hud-ink)" : "var(--hud-paper)",
    cursor: "pointer",
    clipPath: "var(--hud-cut-corners)",
    boxShadow: isPrimary ? "7px 7px 0 rgba(0,0,0,0.34)" : "4px 4px 0 rgba(0,0,0,0.22)",
  };
}

function commandIndexStyle(tone: MenuTone): CSSProperties {
  return {
    color: tone === "gold" ? "rgba(0,0,0,0.58)" : "var(--hud-blue)",
    fontSize: 15,
    fontWeight: 950,
  };
}

function deckCardStyle(active: boolean): CSSProperties {
  return {
    minHeight: 84,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: 6,
    padding: "12px 13px",
    background: active
      ? "linear-gradient(180deg, rgba(255,216,77,0.22), rgba(0,0,0,0.44))"
      : "linear-gradient(180deg, rgba(0,0,0,0.48), rgba(0,0,0,0.28))",
    border: active ? "1px solid rgba(255,216,77,0.64)" : "1px solid rgba(255,255,255,0.16)",
    borderTop: active ? "4px solid var(--hud-gold)" : "4px solid rgba(255,255,255,0.14)",
    clipPath: "var(--hud-cut-corners)",
    boxShadow: active ? "0 14px 32px rgba(0,0,0,0.32)" : "none",
  };
}

function modeButtonStyle(active: boolean): CSSProperties {
  return {
    minHeight: 42,
    padding: "0 18px",
    border: active ? "1px solid var(--hud-gold)" : "1px solid rgba(255,255,255,0.16)",
    background: active ? "var(--hud-gold)" : "rgba(0,0,0,0.32)",
    color: active ? "var(--hud-ink)" : "var(--hud-text)",
    fontWeight: 950,
    fontSize: 14,
    cursor: "pointer",
    clipPath: "var(--hud-cut-corners)",
  };
}

function timelineRowStyle(active: boolean): CSSProperties {
  return {
    width: "100%",
    minHeight: 62,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "11px 12px",
    border: active ? "1px solid var(--hud-gold)" : "1px solid rgba(255,255,255,0.12)",
    borderLeft: active ? "5px solid var(--hud-gold)" : "5px solid rgba(255,255,255,0.12)",
    background: active ? "rgba(255,216,77,0.16)" : "rgba(0,0,0,0.26)",
    color: "var(--hud-text)",
    cursor: "pointer",
    clipPath: "var(--hud-cut-corners)",
  };
}

function worldRowStyle(active: boolean): CSSProperties {
  return {
    ...timelineRowStyle(active),
    minHeight: 68,
  };
}

function kindBadgeStyle(manual: boolean): CSSProperties {
  return {
    flex: "0 0 auto",
    padding: "5px 8px",
    color: manual ? "var(--hud-gold)" : "var(--hud-blue)",
    background: "rgba(0,0,0,0.26)",
    border: manual ? "1px solid rgba(255,216,77,0.35)" : "1px solid rgba(68,216,255,0.32)",
    fontSize: 11,
    fontWeight: 950,
    clipPath: "var(--hud-cut-corners)",
  };
}

function primaryButtonStyle(disabled: boolean): CSSProperties {
  return {
    minHeight: 48,
    padding: "0 22px",
    border: "0",
    background: disabled ? "rgba(255,255,255,0.1)" : "var(--hud-gold)",
    color: disabled ? "var(--hud-dim)" : "var(--hud-ink)",
    fontSize: 15,
    fontWeight: 950,
    cursor: disabled ? "default" : "pointer",
    clipPath: "var(--hud-cut-corners)",
    boxShadow: disabled ? "none" : "5px 5px 0 rgba(0,0,0,0.28)",
  };
}

function subtleButtonStyle(disabled: boolean): CSSProperties {
  return {
    minHeight: 36,
    padding: "0 12px",
    border: "1px solid rgba(68,216,255,0.34)",
    background: disabled ? "rgba(255,255,255,0.06)" : "rgba(68,216,255,0.1)",
    color: disabled ? "var(--hud-dim)" : "var(--hud-blue)",
    fontSize: 13,
    fontWeight: 900,
    cursor: disabled ? "default" : "pointer",
    clipPath: "var(--hud-cut-corners)",
  };
}
