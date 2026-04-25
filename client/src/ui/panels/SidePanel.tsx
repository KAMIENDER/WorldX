import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";
import { CharacterDetail } from "./CharacterDetail";
import { apiClient } from "../services/api-client";
import type { CharacterInfo, SimulationEvent } from "../../types/api";
import { formatActionName } from "../utils/event-format";

export function SidePanel({
  selectedCharId,
  followedCharId,
  onSelect,
  onToggleFollow,
  events,
  onOpenChange,
}: {
  selectedCharId: string | null;
  followedCharId: string | null;
  onSelect: (id: string | null) => void;
  onToggleFollow: (id: string) => void;
  events: SimulationEvent[];
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [characters, setCharacters] = useState<CharacterInfo[]>([]);
  const [open, setOpen] = useState(false);

  const togglePanel = () => {
    if (open) {
      setOpen(false);
      onSelect(null);
      return;
    }
    setOpen(true);
  };

  useEffect(() => {
    apiClient.getCharacters().then(setCharacters).catch(console.warn);
    const timer = setInterval(() => {
      apiClient.getCharacters().then(setCharacters).catch(console.warn);
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (selectedCharId) setOpen(true);
  }, [selectedCharId]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  return (
    <div
      style={{
        position: "fixed",
        top: "var(--hud-safe-top, 92px)",
        right: open ? 12 : 0,
        width: open ? "min(396px, calc(100vw - 24px))" : 0,
        height: "calc(100vh - var(--hud-safe-top, 92px) - 16px)",
        background: open
          ? "linear-gradient(180deg, rgba(12,12,12,0.95), rgba(5,5,5,0.88)), var(--hud-stripe)"
          : "transparent",
        backdropFilter: open ? "blur(10px) saturate(1.04)" : "none",
        transition: "width 0.28s ease, right 0.28s ease",
        display: "flex",
        flexDirection: "column",
        zIndex: 105,
        pointerEvents: open ? "auto" : "none",
        border: open ? "1px solid rgba(255,255,255,0.2)" : "none",
        borderTop: open ? "4px solid var(--hud-gold)" : "none",
        borderRadius: open ? "var(--hud-radius)" : 0,
        boxShadow: open ? "var(--hud-shadow)" : "none",
        overflow: "visible",
      }}
    >
      <button
        onClick={togglePanel}
        style={{
          position: "absolute",
          left: open ? 0 : -12,
          top: 18,
          width: 40,
          height: 52,
          background: open ? "var(--hud-paper)" : "var(--hud-gold)",
          border: "1px solid rgba(0,0,0,0.78)",
          borderRight: open ? "none" : "1px solid rgba(0,0,0,0.78)",
          borderRadius: "3px 0 0 3px",
          color: "var(--hud-ink)",
          cursor: "pointer",
          fontSize: 18,
          transform: "translateX(-100%)",
          zIndex: 106,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "4px 4px 0 rgba(0,0,0,0.35)",
          transition: "background 0.2s, color 0.2s",
          pointerEvents: "auto",
          clipPath: "polygon(8px 0, 100% 0, 100% 100%, 0 100%, 0 8px)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--hud-paper)";
          e.currentTarget.style.color = "var(--hud-ink)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = open ? "var(--hud-paper)" : "var(--hud-gold)";
          e.currentTarget.style.color = "var(--hud-ink)";
        }}
        title={open ? t("sidePanel.collapseTitle") : t("sidePanel.expandTitle")}
      >
        {open ? "▸" : "◂"}
      </button>

      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", padding: "12px", opacity: open ? 1 : 0, transition: "opacity 0.2s" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
              gap: 8,
              flexShrink: 0,
            }}
          >
            <div>
              <div style={{ color: "var(--hud-gold)", fontSize: 10, letterSpacing: 0, textTransform: "uppercase", fontWeight: 900 }}>
                World Dossier
              </div>
              <h3 style={{ color: "var(--hud-text)", fontSize: 18, margin: "2px 0 0", letterSpacing: 0, fontWeight: 950 }}>
              {selectedCharId ? t("sidePanel.charPanel") : t("sidePanel.charList")}
              </h3>
            </div>
            <button
              onClick={togglePanel}
              style={{
                background: "var(--hud-paper)",
                border: "1px solid rgba(0,0,0,0.78)",
                borderRadius: 3,
                color: "var(--hud-ink)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 900,
                padding: "6px 10px",
                clipPath: "var(--hud-cut-corners)",
              }}
            >
              {t("sidePanel.collapse")}
            </button>
          </div>

          <div className="custom-scrollbar" style={{ marginBottom: 12, flexShrink: 0, maxHeight: "32vh", overflowY: "auto", paddingRight: 4 }}>
            <h3 style={{ color: "var(--hud-muted)", fontSize: 11, marginBottom: 8, position: "sticky", top: 0, background: "rgba(12,12,12,0.94)", zIndex: 1, paddingBottom: 6, letterSpacing: 0, textTransform: "uppercase", fontWeight: 900 }}>{t("sidePanel.charList")}</h3>
            {characters.map((c) => (
              <div
                key={c.id}
                onClick={() => {
                  onSelect(c.id);
                  setOpen(true);
                }}
                style={{
                  padding: "9px 10px",
                  borderRadius: 4,
                  cursor: "pointer",
                  background:
                    c.id === selectedCharId
                      ? "linear-gradient(90deg, rgba(255,216,77,0.24), rgba(255,255,255,0.08))"
                      : "rgba(255,255,255,0.055)",
                  color: "var(--hud-text)",
                  fontSize: 12,
                  display: "grid",
                  gridTemplateColumns: "8px minmax(0, 1fr) auto",
                  alignItems: "center",
                  gap: 9,
                  marginBottom: 5,
                  transition: "background 0.15s, border-color 0.15s, transform 0.15s",
                  border: c.id === selectedCharId ? "1px solid rgba(255,216,77,0.48)" : "1px solid rgba(255,255,255,0.12)",
                  borderLeft: c.id === selectedCharId ? "4px solid var(--hud-gold)" : "4px solid rgba(255,255,255,0.14)",
                  clipPath: "var(--hud-cut-corners)",
                }}
              >
                <span style={statusDotStyle(c.bodyCondition)} />
                <span style={{ minWidth: 0, display: "grid", gap: 2 }}>
                  <span style={{ fontWeight: 800, fontSize: 13, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
                  <span style={{ color: "var(--hud-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }} title={c.role}>{c.role}</span>
                </span>
                <span style={actionChipStyle}>
                  {c.currentActionLabel || formatActionName(c.currentAction || "idle")}
                </span>
              </div>
            ))}
          </div>

          {selectedCharId && (
            <CharacterDetail
              key={selectedCharId}
              charId={selectedCharId}
              followedCharId={followedCharId}
              onToggleFollow={onToggleFollow}
              characters={characters}
              liveEvents={events}
            />
          )}
        </div>
    </div>
  );
}

function statusDotStyle(condition: string): CSSProperties {
  const color =
    condition === "critical" || condition === "dead"
      ? "var(--hud-red)"
      : condition === "sick" || condition === "injured" || condition === "tired"
        ? "var(--hud-gold)"
        : "var(--hud-green)";
  return {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: color,
    boxShadow: `0 0 12px ${color}`,
  };
}

const actionChipStyle: CSSProperties = {
  maxWidth: 116,
  justifySelf: "end",
  borderRadius: 2,
  padding: "3px 7px 4px",
  background: "rgba(0,0,0,0.42)",
  border: "1px solid rgba(255,255,255,0.14)",
  color: "var(--hud-gold)",
  fontSize: 10,
  fontWeight: 900,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  clipPath: "var(--hud-cut-corners)",
};
