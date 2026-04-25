import { useState, useEffect, useMemo } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { apiClient } from "../services/api-client";
import type { TimelineWithWorld, TimelineMeta } from "../../types/api";

export function TimelineManagerModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<TimelineWithWorld[]>([]);
  const [currentTimelineId, setCurrentTimelineId] = useState<string | null>(null);
  const [expandedWorldId, setExpandedWorldId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saveName, setSaveName] = useState("");
  const [saveNote, setSaveNote] = useState("");
  const [saveFlash, setSaveFlash] = useState<string | null>(null);

  const currentWorld = useMemo(
    () => groups.find((group) => group.isCurrent) ?? null,
    [groups],
  );

  const loadData = () => {
    setLoading(true);
    apiClient.getAllTimelinesGrouped()
      .then((response) => {
        setGroups(response.groups);
        setCurrentTimelineId(response.currentTimelineId);
        if (response.groups.length > 0 && expandedWorldId === null) {
          const current = response.groups.find((g) => g.isCurrent);
          if (current) setExpandedWorldId(current.worldId);
        }
      })
      .catch((err) => {
        console.warn("[TimelineManager] Failed to load data:", err);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);

  const handleCreateSave = async () => {
    setBusyId("save");
    setSaveFlash(null);
    try {
      const result = await apiClient.createManualSave({
        name: saveName,
        note: saveNote,
      });
      setSaveName("");
      setSaveNote("");
      setSaveFlash(t("manager.saveCreated", { name: result.timeline.name ?? result.timeline.id }));
      loadData();
    } catch (err) {
      window.alert(t("manager.saveFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusyId(null);
    }
  };

  const handleLoadTimeline = async (worldId: string, timeline: TimelineMeta) => {
    if (timeline.id === currentTimelineId) return;
    const confirmed = window.confirm(
      t("manager.confirmLoadTimeline", { name: timeline.name || timeline.id }),
    );
    if (!confirmed) return;

    const loadId = `load:${timeline.id}`;
    setBusyId(loadId);
    try {
      await apiClient.loadTimelineFromWorld(worldId, timeline.id);
      window.location.reload();
    } catch (err) {
      window.alert(t("manager.loadFailed", { error: err instanceof Error ? err.message : String(err) }));
      setBusyId(null);
    }
  };

  const handleDeleteTimeline = async (worldId: string, timeline: TimelineMeta) => {
    if (timeline.id === currentTimelineId) {
      window.alert(t("manager.cannotDeleteActiveTimeline"));
      return;
    }
    const confirmed = window.confirm(
      t("manager.confirmDeleteTimeline", { id: timeline.name || timeline.id }),
    );
    if (!confirmed) return;

    const deleteId = `delete:${timeline.id}`;
    setBusyId(deleteId);
    try {
      await apiClient.deleteTimelineFromWorld(worldId, timeline.id);
      loadData();
    } catch (err) {
      window.alert(t("manager.deleteFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteWorld = async (worldId: string, worldName: string) => {
    const group = groups.find((g) => g.worldId === worldId);
    if (group?.isCurrent) {
      window.alert(t("manager.cannotDeleteActiveWorld"));
      return;
    }
    const confirmed = window.confirm(
      t("manager.confirmDeleteWorld", { name: worldName }),
    );
    if (!confirmed) return;

    const deleteId = `world:${worldId}`;
    setBusyId(deleteId);
    try {
      await apiClient.deleteWorld(worldId);
      loadData();
    } catch (err) {
      window.alert(t("manager.deleteFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusyId(null);
    }
  };

  const isSaving = busyId === "save";
  const saveDisabled = loading || isSaving || !currentWorld;

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <div style={eyebrowStyle}>{t("manager.eyebrow")}</div>
            <div style={titleStyle}>{t("manager.title")}</div>
          </div>
          <button onClick={onClose} style={closeBtnStyle} aria-label={t("manager.close")}>
            X
          </button>
        </div>

        <div style={savePanelStyle}>
          <div style={saveHeaderStyle}>
            <div>
              <div style={sectionTitleStyle}>{t("manager.saveCurrentTitle")}</div>
              <div style={mutedTextStyle}>
                {currentWorld
                  ? t("manager.saveCurrentHint", { world: currentWorld.worldName })
                  : t("manager.noActiveWorld")}
              </div>
            </div>
            <button
              onClick={handleCreateSave}
              disabled={saveDisabled}
              style={primaryActionStyle(saveDisabled)}
            >
              {isSaving ? t("manager.saving") : t("manager.saveNow")}
            </button>
          </div>
          <div style={saveFormStyle}>
            <input
              value={saveName}
              onChange={(event) => setSaveName(event.target.value)}
              maxLength={80}
              placeholder={t("manager.saveNamePlaceholder")}
              disabled={saveDisabled}
              style={inputStyle}
            />
            <input
              value={saveNote}
              onChange={(event) => setSaveNote(event.target.value)}
              maxLength={240}
              placeholder={t("manager.saveNotePlaceholder")}
              disabled={saveDisabled}
              style={{ ...inputStyle, flex: "1 1 260px" }}
            />
          </div>
          {saveFlash && <div style={successTextStyle}>{saveFlash}</div>}
        </div>

        <div className="custom-scrollbar" style={bodyStyle}>
          {loading ? (
            <div style={emptyStyle}>{t("manager.loading")}</div>
          ) : groups.length === 0 ? (
            <div style={emptyStyle}>{t("manager.noWorlds")}</div>
          ) : (
            groups.map((group) => {
              const isExpanded = expandedWorldId === group.worldId;
              const isActiveWorld = group.isCurrent;

              return (
                <div key={group.worldId} style={worldGroupStyle}>
                  <div
                    role="button"
                    tabIndex={0}
                    style={worldRowStyle}
                    onClick={() => setExpandedWorldId(isExpanded ? null : group.worldId)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setExpandedWorldId(isExpanded ? null : group.worldId);
                    }}
                  >
                    <span style={expandMarkStyle}>{isExpanded ? "▾" : "▸"}</span>
                    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={worldNameStyle}>{group.worldName}</div>
                      <div style={worldMetaStyle}>
                        {group.worldId} · {t("manager.timelineCount", { count: group.timelines.length })}
                      </div>
                    </div>
                    {group.source === "library" && (
                      <span style={libraryBadgeStyle}>{t("manager.sampleWorld")}</span>
                    )}
                    {isActiveWorld && (
                      <span style={activeBadgeStyle}>{t("manager.active")}</span>
                    )}
                    {!isActiveWorld && group.source !== "library" && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteWorld(group.worldId, group.worldName);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          e.stopPropagation();
                          handleDeleteWorld(group.worldId, group.worldName);
                        }}
                        style={deleteBtnStyle(busyId === `world:${group.worldId}`)}
                      >
                        {busyId === `world:${group.worldId}` ? "..." : t("manager.delete")}
                      </span>
                    )}
                  </div>

                  {isExpanded && (
                    <div style={timelinesContainerStyle}>
                      {group.timelines.length === 0 ? (
                        <div style={emptyRowStyle}>{t("manager.noTimelines")}</div>
                      ) : (
                        group.timelines.map((tl) => {
                          const isActiveTl = tl.id === currentTimelineId;
                          const kind = tl.saveKind === "manual" ? "manual" : "run";
                          const loadBusy = busyId === `load:${tl.id}`;
                          const deleteBusy = busyId === `delete:${tl.id}`;
                          return (
                            <div key={tl.id} style={timelineRowStyle(isActiveTl)}>
                              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                                <div style={slotTitleRowStyle}>
                                  <span style={slotNameStyle}>{tl.name || formatFallbackSlotName(tl)}</span>
                                  <span style={kindBadgeStyle(kind)}>
                                    {kind === "manual" ? t("manager.manualSave") : t("manager.runTimeline")}
                                  </span>
                                  {tl.worldSnapshotDir && (
                                    <span style={snapshotBadgeStyle}>{t("manager.snapshotReady")}</span>
                                  )}
                                </div>
                                <div style={timelineMetaStyle}>
                                  <span>{formatDate(tl.createdAt)}</span>
                                  <span>{t("manager.dayTicks", { day: tl.lastGameTime.day, ticks: tl.tickCount })}</span>
                                  <span>{tl.id}</span>
                                </div>
                                {(tl.summary || tl.note) && (
                                  <div style={summaryStyle}>{tl.summary || tl.note}</div>
                                )}
                              </div>
                              <div style={rowActionsStyle}>
                                {isActiveTl ? (
                                  <span style={activeBadgeStyle}>{t("manager.active")}</span>
                                ) : (
                                  <button
                                    onClick={() => handleLoadTimeline(group.worldId, tl)}
                                    disabled={loadBusy || busyId !== null}
                                    style={loadBtnStyle(loadBusy || busyId !== null)}
                                  >
                                    {loadBusy ? "..." : t("manager.load")}
                                  </button>
                                )}
                                <button
                                  onClick={() => handleDeleteTimeline(group.worldId, tl)}
                                  disabled={isActiveTl || deleteBusy || busyId !== null}
                                  style={deleteBtnStyle(isActiveTl || deleteBusy || busyId !== null)}
                                >
                                  {deleteBusy ? "..." : t("manager.delete")}
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatFallbackSlotName(tl: TimelineMeta): string {
  return tl.saveKind === "manual" ? tl.id : `#${tl.tickCount}t`;
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.68)",
  backdropFilter: "blur(6px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 10000,
  pointerEvents: "auto",
};

const panelStyle: CSSProperties = {
  width: 760,
  maxWidth: "calc(100vw - 32px)",
  maxHeight: "calc(100vh - 40px)",
  background: "linear-gradient(180deg, rgba(14,14,14,0.98), rgba(5,5,5,0.96)), var(--hud-stripe)",
  border: "1px solid rgba(255,255,255,0.2)",
  borderLeft: "5px solid var(--hud-gold)",
  borderRadius: "var(--hud-radius)",
  boxShadow: "var(--hud-shadow)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  clipPath: "var(--hud-cut-corners)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  padding: "16px 18px 12px",
  borderBottom: "1px solid rgba(255,255,255,0.12)",
  color: "var(--hud-text)",
};

const eyebrowStyle: CSSProperties = {
  color: "var(--hud-gold)",
  fontSize: 10,
  fontWeight: 900,
  letterSpacing: 0,
  textTransform: "uppercase",
};

const titleStyle: CSSProperties = {
  color: "var(--hud-text)",
  fontSize: 20,
  fontWeight: 900,
  lineHeight: 1.2,
};

const closeBtnStyle: CSSProperties = {
  width: 32,
  height: 32,
  background: "var(--hud-paper)",
  border: "1px solid rgba(0,0,0,0.78)",
  color: "var(--hud-ink)",
  borderRadius: 3,
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 900,
  boxShadow: "3px 3px 0 rgba(0,0,0,0.32)",
  clipPath: "var(--hud-cut-corners)",
};

const savePanelStyle: CSSProperties = {
  padding: "14px 18px",
  borderBottom: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.045)",
};

const saveHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const sectionTitleStyle: CSSProperties = {
  color: "var(--hud-text)",
  fontSize: 13,
  fontWeight: 900,
};

const mutedTextStyle: CSSProperties = {
  marginTop: 4,
  color: "var(--hud-muted)",
  fontSize: 12,
  lineHeight: 1.45,
};

const saveFormStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 12,
};

const inputStyle: CSSProperties = {
  flex: "0 1 210px",
  minWidth: 160,
  background: "rgba(5,5,5,0.82)",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "var(--hud-text)",
  borderRadius: 3,
  padding: "9px 10px",
  fontSize: 12,
  outline: "none",
  boxShadow: "2px 2px 0 rgba(0,0,0,0.25)",
};

const successTextStyle: CSSProperties = {
  marginTop: 9,
  color: "var(--hud-green)",
  fontSize: 12,
  fontWeight: 800,
};

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: "12px 14px 16px",
  overflowY: "auto",
  overflowX: "hidden",
  scrollbarWidth: "thin",
  scrollbarColor: "rgba(255,255,255,0.22) transparent",
  scrollbarGutter: "stable",
  display: "flex",
  flexDirection: "column",
  gap: 9,
  color: "var(--hud-text)",
};

const emptyStyle: CSSProperties = {
  textAlign: "center",
  padding: 24,
  color: "var(--hud-muted)",
  fontSize: 13,
};

const emptyRowStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--hud-muted)",
  padding: "10px 14px 10px 34px",
};

const worldGroupStyle: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.035)",
  flexShrink: 0,
  clipPath: "var(--hud-cut-corners)",
};

const worldRowStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "10px 12px",
  cursor: "pointer",
  background: "rgba(255,255,255,0.06)",
  border: "none",
  color: "inherit",
  textAlign: "left",
};

const expandMarkStyle: CSSProperties = {
  width: 16,
  color: "var(--hud-gold)",
  fontSize: 13,
  fontWeight: 900,
  flexShrink: 0,
};

const worldNameStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 900,
  color: "var(--hud-text)",
  lineHeight: 1.25,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const worldMetaStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--hud-muted)",
  lineHeight: 1.3,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const timelinesContainerStyle: CSSProperties = {
  borderTop: "1px solid rgba(255,255,255,0.08)",
  display: "flex",
  flexDirection: "column",
};

function timelineRowStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "11px 12px 11px 34px",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    background: active ? "rgba(255,216,77,0.08)" : "rgba(0,0,0,0.12)",
  };
}

const slotTitleRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  flexWrap: "wrap",
};

const slotNameStyle: CSSProperties = {
  color: "var(--hud-text)",
  fontSize: 13,
  fontWeight: 900,
  lineHeight: 1.25,
};

const timelineMetaStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  flexWrap: "wrap",
  color: "var(--hud-muted)",
  fontSize: 11,
  lineHeight: 1.3,
};

const summaryStyle: CSSProperties = {
  color: "var(--hud-dim)",
  fontSize: 11,
  lineHeight: 1.35,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const rowActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 8,
  flexShrink: 0,
};

const activeBadgeStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--hud-ink)",
  background: "var(--hud-gold)",
  border: "1px solid rgba(0,0,0,0.72)",
  borderRadius: 3,
  padding: "4px 9px",
  whiteSpace: "nowrap",
  flexShrink: 0,
  fontWeight: 900,
  clipPath: "var(--hud-cut-corners)",
};

const libraryBadgeStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--hud-blue)",
  background: "rgba(68,216,255,0.12)",
  border: "1px solid rgba(68,216,255,0.38)",
  borderRadius: 3,
  padding: "4px 9px",
  whiteSpace: "nowrap",
  flexShrink: 0,
  fontWeight: 850,
  clipPath: "var(--hud-cut-corners)",
};

const snapshotBadgeStyle: CSSProperties = {
  fontSize: 10,
  color: "var(--hud-green)",
  background: "rgba(101,242,155,0.12)",
  border: "1px solid rgba(101,242,155,0.36)",
  borderRadius: 3,
  padding: "3px 7px",
  whiteSpace: "nowrap",
  fontWeight: 850,
  clipPath: "var(--hud-cut-corners)",
};

function kindBadgeStyle(kind: "manual" | "run"): CSSProperties {
  return {
    fontSize: 10,
    color: kind === "manual" ? "var(--hud-gold)" : "var(--hud-blue)",
    background: kind === "manual" ? "rgba(255,216,77,0.12)" : "rgba(68,216,255,0.12)",
    border: `1px solid ${kind === "manual" ? "rgba(255,216,77,0.34)" : "rgba(68,216,255,0.32)"}`,
    borderRadius: 3,
    padding: "3px 7px",
    whiteSpace: "nowrap",
    fontWeight: 850,
    clipPath: "var(--hud-cut-corners)",
  };
}

function primaryActionStyle(disabled: boolean): CSSProperties {
  return {
    background: disabled ? "rgba(255,255,255,0.08)" : "var(--hud-gold)",
    border: "1px solid rgba(0,0,0,0.82)",
    color: disabled ? "var(--hud-muted)" : "var(--hud-ink)",
    borderRadius: 3,
    padding: "9px 15px",
    cursor: disabled ? "wait" : "pointer",
    fontSize: 12,
    fontWeight: 900,
    boxShadow: disabled ? "none" : "4px 4px 0 rgba(0,0,0,0.34)",
    opacity: disabled ? 0.7 : 1,
    clipPath: "var(--hud-cut-corners)",
    whiteSpace: "nowrap",
  };
}

function loadBtnStyle(disabled: boolean): CSSProperties {
  return {
    background: disabled ? "rgba(255,255,255,0.08)" : "rgba(68,216,255,0.14)",
    border: "1px solid rgba(68,216,255,0.45)",
    color: disabled ? "var(--hud-muted)" : "var(--hud-blue)",
    borderRadius: 3,
    padding: "6px 11px",
    fontSize: 11,
    cursor: disabled ? "wait" : "pointer",
    opacity: disabled ? 0.65 : 1,
    whiteSpace: "nowrap",
    flexShrink: 0,
    fontWeight: 900,
    clipPath: "var(--hud-cut-corners)",
  };
}

function deleteBtnStyle(disabled: boolean): CSSProperties {
  return {
    background: disabled ? "rgba(255,255,255,0.06)" : "rgba(255,79,94,0.12)",
    border: "1px solid rgba(255,79,94,0.38)",
    color: disabled ? "var(--hud-dim)" : "#ffbcc2",
    borderRadius: 3,
    padding: "6px 11px",
    fontSize: 11,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.58 : 1,
    whiteSpace: "nowrap",
    flexShrink: 0,
    fontWeight: 850,
    clipPath: "var(--hud-cut-corners)",
  };
}
