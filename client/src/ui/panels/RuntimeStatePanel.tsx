import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { apiClient } from "../services/api-client";
import type {
  RuntimeGlobalStateInfo,
  RuntimeObjectStateInfo,
  RuntimeStateInfo,
  RuntimeWorldStateChangeInfo,
} from "../../types/api";

type TabKey = "objects" | "globals" | "changes";

export function RuntimeStatePanel({
  visible,
  refreshKey,
  rightOffset = 14,
}: {
  visible: boolean;
  refreshKey?: string | number;
  rightOffset?: number;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>("objects");
  const [showSystem, setShowSystem] = useState(false);
  const [state, setState] = useState<RuntimeStateInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!visible) return;
    setLoading(true);
    try {
      const next = await apiClient.getRuntimeState();
      setState(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [visible, refresh]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
  }, [visible, refresh, refreshKey]);

  const groupedObjects = useMemo(() => {
    const groups = new Map<string, RuntimeObjectStateInfo[]>();
    for (const object of state?.objects ?? []) {
      const key = `${object.locationName} (${object.locationId})`;
      groups.set(key, [...(groups.get(key) ?? []), object]);
    }
    return [...groups.entries()];
  }, [state?.objects]);

  const visibleGlobals = useMemo(
    () => (state?.globalStates ?? []).filter((entry) => showSystem || !entry.isSystem),
    [showSystem, state?.globalStates],
  );

  if (!visible) return null;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ ...collapsedButtonStyle, right: rightOffset }}
        title="世界状态"
      >
        世界状态
      </button>
    );
  }

  return (
    <div style={{ ...panelStyle, right: rightOffset }}>
      <div style={headerStyle}>
        <div>
          <div style={titleStyle}>世界状态</div>
          <div style={subtitleStyle}>
            {state
              ? `Day ${state.gameTime.day} · ${state.gameTime.timeString} · ${state.currentTimelineId ?? "无时间线"}`
              : "读取中"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={refresh} disabled={loading} style={iconButtonStyle} title="刷新">
            ↻
          </button>
          <button onClick={() => setOpen(false)} style={iconButtonStyle} title="收起">
            ×
          </button>
        </div>
      </div>

      <div style={tabsStyle}>
        <TabButton active={tab === "objects"} onClick={() => setTab("objects")}>
          物件 {state?.objects.length ?? 0}
        </TabButton>
        <TabButton active={tab === "globals"} onClick={() => setTab("globals")}>
          全局 {visibleGlobals.length}
        </TabButton>
        <TabButton active={tab === "changes"} onClick={() => setTab("changes")}>
          变化 {state?.recentWorldStateChanges.length ?? 0}
        </TabButton>
      </div>

      {error && <div style={errorStyle}>{error}</div>}

      <div style={bodyStyle}>
        {tab === "objects" && (
          <div style={{ display: "grid", gap: 8 }}>
            {groupedObjects.length === 0 && <EmptyLine text="暂无物件状态" />}
            {groupedObjects.map(([location, objects]) => (
              <section key={location} style={sectionStyle}>
                <div style={sectionTitleStyle}>{location}</div>
                <div style={{ display: "grid", gap: 6 }}>
                  {objects.map((object) => (
                    <ObjectRow key={object.objectId} object={object} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {tab === "globals" && (
          <div style={{ display: "grid", gap: 8 }}>
            <label style={checkRowStyle}>
              <input
                type="checkbox"
                checked={showSystem}
                onChange={(event) => setShowSystem(event.currentTarget.checked)}
              />
              显示系统键
            </label>
            {visibleGlobals.length === 0 && <EmptyLine text="暂无全局状态" />}
            {visibleGlobals.map((entry) => (
              <GlobalRow key={entry.key} entry={entry} />
            ))}
          </div>
        )}

        {tab === "changes" && (
          <div style={{ display: "grid", gap: 8 }}>
            {(state?.recentWorldStateChanges ?? []).length === 0 && (
              <EmptyLine text="暂无世界状态变化" />
            )}
            {(state?.recentWorldStateChanges ?? []).map((change) => (
              <ChangeRow key={change.id} change={change} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} style={tabButtonStyle(active)}>
      {children}
    </button>
  );
}

function ObjectRow({ object }: { object: RuntimeObjectStateInfo }) {
  const changedFromDefault =
    object.knownStates.length > 0 && !object.knownStates.includes(object.state);
  return (
    <div style={rowStyle}>
      <div style={rowTopStyle}>
        <span style={nameStyle}>{object.name}</span>
        <span style={idStyle}>{object.objectId}</span>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span style={stateChipStyle(changedFromDefault)}>{object.state}</span>
        {object.currentUsers.length > 0 && (
          <span style={mutedChipStyle}>使用中 {object.currentUsers.length}</span>
        )}
      </div>
      {object.stateDescription && (
        <div style={descriptionStyle}>{object.stateDescription}</div>
      )}
    </div>
  );
}

function GlobalRow({ entry }: { entry: RuntimeGlobalStateInfo }) {
  return (
    <div style={rowStyle}>
      <div style={rowTopStyle}>
        <span style={nameStyle}>{entry.key}</span>
        {entry.isSystem && <span style={mutedChipStyle}>system</span>}
      </div>
      <div style={descriptionStyle}>{formatGlobalValue(entry.value)}</div>
    </div>
  );
}

function ChangeRow({ change }: { change: RuntimeWorldStateChangeInfo }) {
  return (
    <div style={rowStyle}>
      <div style={rowTopStyle}>
        <span style={nameStyle}>Day {change.gameDay} · T{change.gameTick}</span>
        <span style={idStyle}>{change.locationName}</span>
      </div>
      <div style={descriptionStyle}>
        {change.data.description || "状态发生变化"}
      </div>
      {change.data.objectUpdates?.map((update, index) => (
        <div key={`${update.objectId}-${index}`} style={detailLineStyle}>
          {update.objectName ?? update.objectId}: {update.previousState ?? "?"} → {update.state ?? "?"}
        </div>
      ))}
      {change.data.worldStateUpdates?.map((update, index) => (
        <div key={`${update.key}-${index}`} style={detailLineStyle}>
          {update.key}: {update.previousValue ?? "∅"} → {update.value}
        </div>
      ))}
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div style={emptyStyle}>{text}</div>;
}

function formatGlobalValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 180) return trimmed;
  return `${trimmed.slice(0, 180)}...`;
}

const collapsedButtonStyle: CSSProperties = {
  position: "fixed",
  right: 14,
  bottom: 14,
  zIndex: 118,
  pointerEvents: "auto",
  height: 36,
  padding: "0 14px",
  borderRadius: 3,
  border: "1px solid rgba(0,0,0,0.78)",
  background: "var(--hud-gold)",
  color: "var(--hud-ink)",
  fontSize: 12,
  fontWeight: 950,
  cursor: "pointer",
  boxShadow: "var(--hud-shadow)",
  letterSpacing: 0,
  clipPath: "var(--hud-cut-corners)",
};

const panelStyle: CSSProperties = {
  position: "fixed",
  right: 14,
  bottom: 14,
  zIndex: 118,
  width: 380,
  maxWidth: "calc(100vw - 24px)",
  maxHeight: "min(560px, calc(100vh - 96px))",
  pointerEvents: "auto",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  borderRadius: 4,
  border: "1px solid rgba(255,255,255,0.2)",
  borderTop: "4px solid var(--hud-gold)",
  background: "linear-gradient(180deg, rgba(12,12,12,0.95), rgba(5,5,5,0.88)), var(--hud-stripe)",
  color: "var(--hud-text)",
  boxShadow: "var(--hud-shadow)",
  backdropFilter: "blur(10px) saturate(1.04)",
  clipPath: "var(--hud-cut-corners)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 10,
  padding: "12px 12px 9px",
  borderBottom: "1px solid rgba(255,255,255,0.12)",
};

const titleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 950,
  letterSpacing: 0,
};

const subtitleStyle: CSSProperties = {
  marginTop: 3,
  fontSize: 10,
  color: "var(--hud-dim)",
};

const iconButtonStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 2,
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(255,255,255,0.08)",
  color: "var(--hud-text)",
  cursor: "pointer",
  fontWeight: 950,
  clipPath: "var(--hud-cut-corners)",
};

const tabsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: 4,
  padding: 8,
  borderBottom: "1px solid rgba(255,255,255,0.1)",
};

const tabButtonStyle = (active: boolean): CSSProperties => ({
  height: 28,
  borderRadius: 2,
  border: `1px solid ${active ? "rgba(0,0,0,0.78)" : "rgba(255,255,255,0.12)"}`,
  background: active ? "var(--hud-gold)" : "rgba(255,255,255,0.05)",
  color: active ? "var(--hud-ink)" : "rgba(248,243,230,0.7)",
  fontSize: 11,
  fontWeight: active ? 950 : 750,
  cursor: "pointer",
  clipPath: "var(--hud-cut-corners)",
});

const bodyStyle: CSSProperties = {
  overflow: "auto",
  padding: 10,
};

const sectionStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 900,
  color: "var(--hud-gold)",
};

const rowStyle: CSSProperties = {
  borderRadius: 3,
  border: "1px solid rgba(255,255,255,0.12)",
  borderLeft: "3px solid rgba(255,216,77,0.55)",
  background: "rgba(255,255,255,0.055)",
  padding: 8,
  display: "grid",
  gap: 6,
  clipPath: "var(--hud-cut-corners)",
};

const rowTopStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  alignItems: "center",
};

const nameStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 850,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const idStyle: CSSProperties = {
  fontSize: 10,
  color: "var(--hud-dim)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const stateChipStyle = (changed: boolean): CSSProperties => ({
  borderRadius: 2,
  border: `1px solid ${changed ? "rgba(255, 185, 86, 0.42)" : "rgba(111, 222, 151, 0.32)"}`,
  background: changed ? "rgba(255, 216, 77, 0.16)" : "rgba(101, 242, 155, 0.12)",
  color: changed ? "var(--hud-gold)" : "#bdf7cc",
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 900,
  clipPath: "var(--hud-cut-corners)",
});

const mutedChipStyle: CSSProperties = {
  borderRadius: 2,
  background: "rgba(255,255,255,0.08)",
  color: "rgba(248,243,230,0.62)",
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 850,
};

const descriptionStyle: CSSProperties = {
  fontSize: 11,
  color: "rgba(248,243,230,0.72)",
  lineHeight: 1.45,
  wordBreak: "break-word",
};

const detailLineStyle: CSSProperties = {
  fontSize: 10,
  color: "rgba(248,243,230,0.58)",
  lineHeight: 1.35,
};

const checkRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  color: "rgba(248,243,230,0.68)",
};

const emptyStyle: CSSProperties = {
  padding: "20px 10px",
  borderRadius: 3,
  border: "1px dashed rgba(255,255,255,0.12)",
  color: "rgba(248,243,230,0.45)",
  fontSize: 12,
  textAlign: "center",
};

const errorStyle: CSSProperties = {
  margin: "8px 10px 0",
  padding: "7px 8px",
  borderRadius: 3,
  border: "1px solid rgba(255, 105, 105, 0.25)",
  background: "rgba(255, 105, 105, 0.1)",
  color: "#ffb5b5",
  fontSize: 11,
};
