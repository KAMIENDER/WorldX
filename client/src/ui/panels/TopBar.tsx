import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { CSSProperties, ChangeEvent } from "react";
import { createPortal } from "react-dom";
import type { WorldTimeInfo } from "../../types/api";
import { apiClient } from "../services/api-client";
import type { WorldInfo, GeneratedWorldSummary } from "../services/api-client";
import { GodPanel } from "./GodPanel";
import { SandboxChatPanel } from "./SandboxChatPanel";

const SPEED_OPTIONS = [
  { label: "Instant", value: 0 },
  { label: "30s per tick", value: 30000 },
  { label: "1m per tick", value: 60000 },
  { label: "5m per tick", value: 300000 },
];

export function TopBar({
  worldInfo,
  gameTime,
  isDevMode,
  showWalkableOverlay,
  showRegionBoundsOverlay,
  showMainAreaPointsOverlay,
  showInteractiveObjectsOverlay,
  onToggleWalkableOverlay,
  onToggleRegionBoundsOverlay,
  onToggleMainAreaPointsOverlay,
  onToggleInteractiveObjectsOverlay,
  onToggleAutoPlay,
  onChangeTickInterval,
  onResetWorld,
  simStatus,
  autoPlayEnabled,
  tickIntervalMs,
  isResetting,
  onHeightChange,
}: {
  worldInfo?: WorldInfo | null;
  gameTime: WorldTimeInfo;
  isDevMode: boolean;
  showWalkableOverlay: boolean;
  showRegionBoundsOverlay: boolean;
  showMainAreaPointsOverlay: boolean;
  showInteractiveObjectsOverlay: boolean;
  onToggleWalkableOverlay: () => void;
  onToggleRegionBoundsOverlay: () => void;
  onToggleMainAreaPointsOverlay: () => void;
  onToggleInteractiveObjectsOverlay: () => void;
  onToggleAutoPlay: () => void;
  onChangeTickInterval: (intervalMs: number) => void;
  onResetWorld: () => void;
  simStatus: "idle" | "running" | "paused" | "error";
  autoPlayEnabled: boolean;
  tickIntervalMs: number;
  isResetting: boolean;
  onHeightChange?: (height: number) => void;
}) {
  const navigate = useNavigate();
  const [availableWorlds, setAvailableWorlds] = useState<GeneratedWorldSummary[]>([]);
  const [selectedWorldId, setSelectedWorldId] = useState("");
  const [isSwitchingWorld, setIsSwitchingWorld] = useState(false);
  const [godPanelOpen, setGodPanelOpen] = useState(false);
  const [sandboxChatOpen, setSandboxChatOpen] = useState(false);
  const [showPauseToast, setShowPauseToast] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const isRunning = simStatus === "running";
  const isBusy = isRunning || isResetting || isSwitchingWorld;
  const autoPlayToggleDisabled = isResetting || isSwitchingWorld || (isRunning && !autoPlayEnabled);

  useEffect(() => {
    let cancelled = false;

    apiClient.getGeneratedWorlds()
      .then((response) => {
        if (cancelled) return;
        setAvailableWorlds(response.worlds);
        const defaultWorldId =
          response.currentWorldId ||
          response.worlds.find((world) => world.isCurrent)?.id ||
          response.worlds[0]?.id ||
          "";
        if (defaultWorldId) {
          setSelectedWorldId(defaultWorldId);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (worldInfo?.currentWorldId) {
      setSelectedWorldId(worldInfo.currentWorldId);
    }
  }, [worldInfo?.currentWorldId]);

  useEffect(() => {
    if (!onHeightChange || !barRef.current) return;

    const node = barRef.current;
    const notifyHeight = () => {
      onHeightChange(Math.ceil(node.getBoundingClientRect().height));
    };

    notifyHeight();
    const observer = new ResizeObserver(notifyHeight);
    observer.observe(node);
    window.addEventListener("resize", notifyHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", notifyHeight);
    };
  }, [onHeightChange]);

  const statusLabel =
    isSwitchingWorld
      ? "Switching World"
      : isResetting
      ? "Resetting"
      : simStatus === "running"
      ? "Simulating"
      : autoPlayEnabled
        ? "Auto Play"
      : simStatus === "paused"
        ? "Paused"
        : simStatus === "error"
          ? "Error"
          : "Idle";
  const statusColor =
    isSwitchingWorld
      ? "#9b59b6"
      : isResetting
      ? "#e67e22"
      : simStatus === "running"
      ? "#f39c12"
      : simStatus === "error"
        ? "#e74c3c"
        : simStatus === "paused"
          ? "#95a5a6"
          : "#00b894";

  const worldName = worldInfo?.worldName || "WorldSeed";
  const timeLabel = gameTime.timeString
    ? `Day ${gameTime.day} · ${gameTime.timeString}${gameTime.period ? ` · ${gameTime.period}` : ""}`
    : `Day ${gameTime.day}`;

  const handleWorldChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextWorldId = event.target.value;
    if (!nextWorldId || nextWorldId === selectedWorldId) return;

    const nextWorld = availableWorlds.find((world) => world.id === nextWorldId);
    const confirmed = window.confirm(
      `Switch to "${nextWorld?.worldName ?? nextWorldId}"? This will reset the current simulation state and reload the page.`,
    );
    if (!confirmed) {
      return;
    }

    const previousWorldId = selectedWorldId;
    setSelectedWorldId(nextWorldId);
    setIsSwitchingWorld(true);
    try {
      await apiClient.switchWorld(nextWorldId);
      window.location.reload();
    } catch (error) {
      setSelectedWorldId(previousWorldId);
      console.warn("[TopBar] Failed to switch world:", error);
      window.alert(`Switch failed: ${error instanceof Error ? error.message : String(error)}`);
      setIsSwitchingWorld(false);
    }
  };

  return (
    <div
      ref={barRef}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        background: "linear-gradient(180deg, rgba(10,12,24,0.96), rgba(10,12,24,0.92))",
        backdropFilter: "blur(10px)",
        display: "flex",
        flexDirection: "column",
        padding: "10px 14px",
        gap: 10,
        color: "#e0e0e0",
        fontSize: 13,
        zIndex: 100,
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 10px 28px rgba(0,0,0,0.24)",
        pointerEvents: "auto",
      }}
    >
      {/* 第一行：状态信息与核心控制 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 15, whiteSpace: "nowrap" }}>
            🌍 {worldName}
          </span>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: statusColor,
              animation: isBusy ? "pulse 1s infinite" : "pulse 2s infinite",
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 11, opacity: 0.78, whiteSpace: "nowrap" }}>{statusLabel}</span>
          <span style={{ opacity: 0.45 }}>|</span>
          <span style={{ fontSize: 12, color: "#dfe6e9", whiteSpace: "nowrap" }}>
            {timeLabel}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {availableWorlds.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, opacity: 0.72, whiteSpace: "nowrap" }}>Scene</span>
              <select
                value={selectedWorldId}
                onChange={handleWorldChange}
                disabled={isBusy}
                style={{ ...selectStyle, maxWidth: 280 }}
                title="Switch generated world"
              >
                {availableWorlds.map((world) => (
                  <option key={world.id} value={world.id}>
                    {world.worldName} ({world.id})
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            onClick={onToggleAutoPlay}
            disabled={autoPlayToggleDisabled}
            style={{
              ...primaryBtnStyle,
              background: autoPlayEnabled ? "rgba(116,185,255,0.24)" : "rgba(116,185,255,0.14)",
              borderColor: "rgba(116,185,255,0.45)",
              cursor: autoPlayToggleDisabled ? "wait" : "pointer",
              opacity: autoPlayToggleDisabled ? 0.82 : 1,
            }}
          >
            {autoPlayEnabled ? "Pause" : "Play"}
          </button>

          <select
            value={tickIntervalMs}
            onChange={(e) => onChangeTickInterval(Number(e.target.value))}
            disabled={isBusy}
            style={selectStyle}
          >
            {SPEED_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 第二行：功能入口与调试工具 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
        <button onClick={() => navigate("/graph")} style={chipBtnStyle(false)}>
          Relations
        </button>
        <button onClick={() => navigate("/timeline")} style={chipBtnStyle(false)}>
          Timeline
        </button>
        <button
          onClick={() => setGodPanelOpen(true)}
          style={chipBtnStyle(godPanelOpen)}
          title="向世界广播事件或给某个角色植入记忆"
        >
          👁️ 上帝视角
        </button>
        <button
          onClick={() => {
            setSandboxChatOpen(true);
            if (autoPlayEnabled) {
              onToggleAutoPlay();
              setShowPauseToast(true);
              setTimeout(() => setShowPauseToast(false), 3500);
            }
          }}
          style={chipBtnStyle(sandboxChatOpen)}
          title="把某个角色叫出来单独聊（不进入记忆、不影响世界）"
        >
          💬 架空对话
        </button>

        <div style={{ flex: 1 }} />

        {isDevMode && (
          <>
            <button
              onClick={onToggleWalkableOverlay}
              style={chipBtnStyle(showWalkableOverlay)}
              title="显示可行走区域调试图层"
            >
              可行走区
            </button>
            <button
              onClick={onToggleRegionBoundsOverlay}
              style={chipBtnStyle(showRegionBoundsOverlay)}
              title="显示功能区边框"
            >
              功能区
            </button>
            <button
              onClick={onToggleMainAreaPointsOverlay}
              style={chipBtnStyle(showMainAreaPointsOverlay)}
              title="显示 main_area 点位"
            >
              点位
            </button>
            <button
              onClick={onToggleInteractiveObjectsOverlay}
              style={chipBtnStyle(showInteractiveObjectsOverlay)}
              title="显示可交互元素边框和名称"
            >
              可交互元素
            </button>
          </>
        )}
        <button
          onClick={onResetWorld}
          disabled={isBusy}
          style={{
            ...secondaryBtnStyle,
            color: "#ffb0b0",
            borderColor: "rgba(231,76,60,0.35)",
            background: "rgba(231,76,60,0.12)",
            cursor: isBusy ? "wait" : "pointer",
            opacity: isBusy ? 0.7 : 1,
          }}
        >
          {isResetting ? "Resetting..." : "Reset World"}
        </button>
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
        <div
          style={{
            position: "fixed",
            top: 72,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(10, 14, 28, 0.95)",
            border: "1px solid rgba(116,185,255,0.4)",
            color: "#dff3ff",
            padding: "8px 16px",
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 500,
            zIndex: 9999,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            animation: "slideDownFade 3.5s forwards",
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>⏸️</span> 已自动暂停主世界运行
        </div>,
        document.body
      )}

      {godPanelOpen && typeof document !== "undefined"
        ? createPortal(<GodPanel onClose={() => setGodPanelOpen(false)} />, document.body)
        : null}
      {sandboxChatOpen && typeof document !== "undefined"
        ? createPortal(<SandboxChatPanel onClose={() => setSandboxChatOpen(false)} />, document.body)
        : null}
    </div>
  );
}

const primaryBtnStyle: CSSProperties = {
  color: "#fff",
  borderRadius: 999,
  padding: "6px 14px",
  fontSize: 12,
  border: "1px solid",
  transition: "all 0.2s",
};

const secondaryBtnStyle: CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#e0e0e0",
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: 12,
};

const selectStyle: CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#e0e0e0",
  borderRadius: 999,
  padding: "6px 10px",
  fontSize: 12,
};

function chipBtnStyle(active: boolean): CSSProperties {
  return {
    background: active ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.08)",
    border: `1px solid ${active ? "rgba(116,185,255,0.42)" : "rgba(255,255,255,0.15)"}`,
    color: active ? "#dff3ff" : "#e0e0e0",
    borderRadius: 999,
    padding: "6px 12px",
    cursor: "pointer",
    fontSize: 12,
    transition: "all 0.2s",
  };
}
