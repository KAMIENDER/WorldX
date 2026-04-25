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
}: {
  visible: boolean;
  refreshKey?: string | number;
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
        style={collapsedButtonStyle}
        title="世界状态"
      >
        世界状态
      </button>
    );
  }

  return (
    <div style={panelStyle}>
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
  right: 12,
  bottom: 12,
  zIndex: 110,
  pointerEvents: "auto",
  height: 32,
  padding: "0 12px",
  borderRadius: 6,
  border: "1px solid rgba(120, 190, 255, 0.42)",
  background: "rgba(7, 13, 24, 0.88)",
  color: "#dff1ff",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  boxShadow: "0 10px 24px rgba(0,0,0,0.28)",
};

const panelStyle: CSSProperties = {
  position: "fixed",
  right: 12,
  bottom: 12,
  zIndex: 110,
  width: 380,
  maxWidth: "calc(100vw - 24px)",
  maxHeight: "min(560px, calc(100vh - 96px))",
  pointerEvents: "auto",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(9, 14, 24, 0.94)",
  color: "#edf2fb",
  boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
  backdropFilter: "blur(12px)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 10,
  padding: "10px 10px 8px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
};

const titleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
};

const subtitleStyle: CSSProperties = {
  marginTop: 3,
  fontSize: 10,
  color: "rgba(237,242,251,0.56)",
};

const iconButtonStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 5,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.06)",
  color: "#edf2fb",
  cursor: "pointer",
};

const tabsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: 4,
  padding: 8,
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

const tabButtonStyle = (active: boolean): CSSProperties => ({
  height: 28,
  borderRadius: 5,
  border: `1px solid ${active ? "rgba(120,190,255,0.45)" : "rgba(255,255,255,0.08)"}`,
  background: active ? "rgba(57, 132, 214, 0.22)" : "rgba(255,255,255,0.04)",
  color: active ? "#e8f5ff" : "rgba(237,242,251,0.68)",
  fontSize: 11,
  cursor: "pointer",
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
  fontWeight: 700,
  color: "rgba(237,242,251,0.72)",
};

const rowStyle: CSSProperties = {
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(255,255,255,0.045)",
  padding: 8,
  display: "grid",
  gap: 6,
};

const rowTopStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  alignItems: "center",
};

const nameStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const idStyle: CSSProperties = {
  fontSize: 10,
  color: "rgba(237,242,251,0.42)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const stateChipStyle = (changed: boolean): CSSProperties => ({
  borderRadius: 5,
  border: `1px solid ${changed ? "rgba(255, 185, 86, 0.42)" : "rgba(111, 222, 151, 0.32)"}`,
  background: changed ? "rgba(255, 185, 86, 0.14)" : "rgba(111, 222, 151, 0.11)",
  color: changed ? "#ffd69c" : "#bdf7cc",
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 700,
});

const mutedChipStyle: CSSProperties = {
  borderRadius: 5,
  background: "rgba(255,255,255,0.08)",
  color: "rgba(237,242,251,0.62)",
  padding: "2px 6px",
  fontSize: 10,
};

const descriptionStyle: CSSProperties = {
  fontSize: 11,
  color: "rgba(237,242,251,0.72)",
  lineHeight: 1.45,
  wordBreak: "break-word",
};

const detailLineStyle: CSSProperties = {
  fontSize: 10,
  color: "rgba(237,242,251,0.58)",
  lineHeight: 1.35,
};

const checkRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  color: "rgba(237,242,251,0.68)",
};

const emptyStyle: CSSProperties = {
  padding: "20px 10px",
  borderRadius: 6,
  border: "1px dashed rgba(255,255,255,0.12)",
  color: "rgba(237,242,251,0.45)",
  fontSize: 12,
  textAlign: "center",
};

const errorStyle: CSSProperties = {
  margin: "8px 10px 0",
  padding: "7px 8px",
  borderRadius: 6,
  border: "1px solid rgba(255, 105, 105, 0.25)",
  background: "rgba(255, 105, 105, 0.1)",
  color: "#ffb5b5",
  fontSize: 11,
};
