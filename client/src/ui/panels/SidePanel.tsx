import { useEffect, useState } from "react";
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
}: {
  selectedCharId: string | null;
  followedCharId: string | null;
  onSelect: (id: string | null) => void;
  onToggleFollow: (id: string) => void;
  events: SimulationEvent[];
}) {
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

  return (
    <div
      style={{
        position: "fixed",
        top: "var(--top-ui-offset, 52px)",
        right: 0,
        width: open ? 380 : 0,
        height: "calc(100vh - var(--top-ui-offset, 52px))",
        background: open
          ? "linear-gradient(180deg, rgba(20,20,40,0.95), rgba(20,20,40,0.9))"
          : "transparent",
        backdropFilter: open ? "blur(8px)" : "none",
        transition: "width 0.3s ease",
        display: "flex",
        flexDirection: "column",
        zIndex: 90,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      <button
        onClick={togglePanel}
        style={{
          position: "absolute",
          left: 0,
          top: 16,
          width: 36,
          height: 48,
          background: "linear-gradient(90deg, rgba(26,26,46,0.95), rgba(30,30,50,0.8))",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRight: "none",
          borderRadius: "8px 0 0 8px",
          color: "#e0e0e0",
          cursor: "pointer",
          fontSize: 18,
          transform: "translateX(-100%)",
          zIndex: 91,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "-2px 0 8px rgba(0,0,0,0.3)",
          transition: "background 0.2s, color 0.2s",
          pointerEvents: "auto",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "linear-gradient(90deg, rgba(40,40,60,0.95), rgba(30,30,50,0.8))";
          e.currentTarget.style.color = "#fff";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "linear-gradient(90deg, rgba(26,26,46,0.95), rgba(30,30,50,0.8))";
          e.currentTarget.style.color = "#e0e0e0";
        }}
        title={open ? "收起角色面板" : "展开角色面板"}
      >
        {open ? "▸" : "◂"}
      </button>

      <div style={{ flex: 1, overflow: "auto", padding: "8px 12px", opacity: open ? 1 : 0, transition: "opacity 0.2s" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
              gap: 8,
            }}
          >
            <h3 style={{ color: "#e0e0e0", fontSize: 14, margin: 0 }}>
              {selectedCharId ? "角色面板" : "角色列表"}
            </h3>
            <button
              onClick={togglePanel}
              style={{
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 6,
                color: "#e0e0e0",
                cursor: "pointer",
                fontSize: 12,
                padding: "4px 8px",
              }}
            >
              收起
            </button>
          </div>

          <div style={{ marginBottom: 12 }}>
            <h3 style={{ color: "#e0e0e0", fontSize: 13, marginBottom: 8 }}>角色列表</h3>
            {characters.map((c) => (
              <div
                key={c.id}
                onClick={() => {
                  onSelect(c.id);
                  setOpen(true);
                }}
                style={{
                  padding: "6px 8px",
                  borderRadius: 6,
                  cursor: "pointer",
                  background:
                    c.id === selectedCharId
                      ? "rgba(255,255,255,0.12)"
                      : "transparent",
                  color: "#e0e0e0",
                  fontSize: 12,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 2,
                  transition: "background 0.15s",
                }}
              >
                <span style={{ opacity: 0.7 }}>{c.mbti}</span>
                <span style={{ fontWeight: 500 }}>{c.name}</span>
                <span style={{ marginLeft: "auto", opacity: 0.5 }}>
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
