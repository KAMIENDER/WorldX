import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { apiClient } from "../services/api-client";
import type {
  CharacterDetail as CharDetailType,
  RelationshipEdge,
  MemoryEntry,
  SimulationEvent,
  CharacterInfo,
  LocationInfo,
} from "../../types/api";
import {
  buildCharacterNameMap,
  buildLocationNameMap,
  formatActionName,
  formatEventSummary,
  formatEventType,
} from "../utils/event-format";

type Tab = "history" | "relations" | "memory";

export function CharacterDetail({
  charId,
  followedCharId,
  onToggleFollow,
  characters,
  liveEvents,
}: {
  charId: string;
  followedCharId: string | null;
  onToggleFollow: (id: string) => void;
  characters: CharacterInfo[];
  liveEvents: SimulationEvent[];
}) {
  const [detail, setDetail] = useState<CharDetailType | null>(null);
  const [tab, setTab] = useState<Tab>("history");
  const [relations, setRelations] = useState<RelationshipEdge[]>([]);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [locations, setLocations] = useState<LocationInfo[]>([]);
  const [storedEvents, setStoredEvents] = useState<SimulationEvent[]>([]);

  useEffect(() => {
    apiClient.getCharacterDetail(charId).then(setDetail).catch(console.warn);
  }, [charId]);

  useEffect(() => {
    apiClient.getLocations().then(setLocations).catch(console.warn);
  }, []);

  useEffect(() => {
    if (tab === "history") apiClient.getEvents({}).then(setStoredEvents).catch(console.warn);
    if (tab === "relations") apiClient.getRelationships(charId).then(setRelations).catch(console.warn);
    if (tab === "memory") apiClient.getMemories(charId).then(setMemories).catch(console.warn);
  }, [charId, tab]);
  const characterNames = useMemo(() => buildCharacterNameMap(characters), [characters]);
  const locationNames = useMemo(() => buildLocationNameMap(locations), [locations]);
  const mergedHistory = useMemo(() => {
    const merged = new Map<string, SimulationEvent>();
    [...storedEvents, ...liveEvents].forEach((event, index) => {
      if (!eventTouchesCharacter(event, charId)) return;
      merged.set(event.id || `${event.type}-${event.gameDay}-${event.gameTick}-${index}`, event);
    });
    return Array.from(merged.values()).sort(compareEventsDesc);
  }, [charId, liveEvents, storedEvents]);

  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState<Record<string, string>>({});
  const [editBusy, setEditBusy] = useState(false);
  const [editFlash, setEditFlash] = useState<string | null>(null);

  if (!detail) return null;

  const { profile, state, emotionLabel } = detail;
  const isFollowing = followedCharId === charId;
  const relationStrength = (relation: RelationshipEdge) => {
    const { familiarity, trust, affection } = relation.dimensions;
    return Math.round((familiarity + trust + affection) / 3);
  };

  const openEditor = () => {
    setEditDraft({
      coreTraits: (profile.coreTraits ?? []).join("、"),
      coreMotivation: profile.coreMotivation ?? "",
      coreValues: ((profile.coreValues as string[]) ?? []).join("、"),
      speakingStyle: profile.speakingStyle ?? "",
      fears: ((profile.fears as string[]) ?? []).join("、"),
      backstory: (profile.backstory as string) ?? "",
    });
    setEditing(true);
    setEditFlash(null);
  };

  const saveProfile = async () => {
    setEditBusy(true);
    try {
      const split = (s: string) => s.split(/[,、，\s]+/).map((t) => t.trim()).filter(Boolean);
      await apiClient.patchCharacterProfile(charId, {
        coreTraits: split(editDraft.coreTraits ?? ""),
        coreMotivation: editDraft.coreMotivation?.trim() || undefined,
        coreValues: split(editDraft.coreValues ?? ""),
        speakingStyle: editDraft.speakingStyle?.trim() || undefined,
        fears: split(editDraft.fears ?? ""),
        backstory: editDraft.backstory?.trim() || undefined,
      });
      setEditFlash("已保存");
      setTimeout(() => setEditFlash(null), 2000);
      setEditing(false);
      apiClient.getCharacterDetail(charId).then(setDetail).catch(console.warn);
    } catch (err) {
      setEditFlash(`失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setEditBusy(false);
    }
  };

  return (
    <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 10, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>
          {profile.name}
        </span>
        <span style={{ fontSize: 11, color: "#74b9ff" }}>{profile.mbtiType}</span>
        <button
          onClick={() => onToggleFollow(charId)}
          style={{
            background: isFollowing ? "rgba(116,185,255,0.18)" : "rgba(255,255,255,0.1)",
            border: isFollowing
              ? "1px solid rgba(116,185,255,0.45)"
              : "1px solid rgba(255,255,255,0.2)",
            color: isFollowing ? "#dff3ff" : "#e0e0e0",
            borderRadius: 4,
            padding: "2px 8px",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          {isFollowing ? "取消跟随" : "跟随"}
        </button>
        <button onClick={openEditor} style={editBtnStyle}>✏️ 改人设</button>
      </div>

      <div style={{ fontSize: 11, color: "#aaa", marginBottom: 8, lineHeight: 1.6 }}>
        <div>
          位置: {locationNames[state.location] || state.location} · 情绪: {emotionLabel}
          {state.currentAction ? ` · 行动: ${state.currentActionLabel || formatActionName(state.currentAction)}` : ""}
        </div>
      </div>

      {editFlash && !editing && (
        <div style={{ fontSize: 11, color: "#8df3cf", marginBottom: 6 }}>{editFlash}</div>
      )}

      {editing && (
        <ProfileEditor
          draft={editDraft}
          onChange={setEditDraft}
          onSave={saveProfile}
          onCancel={() => setEditing(false)}
          busy={editBusy}
          flash={editFlash}
        />
      )}

      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        {(["history", "relations", "memory"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              background: tab === t ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.05)",
              border: "none",
              color: tab === t ? "#fff" : "#888",
              borderRadius: 4,
              padding: "4px 0",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            {{ history: "历史", relations: "关系", memory: "记忆" }[t]}
          </button>
        ))}
      </div>

      <div style={{ maxHeight: 320, overflow: "auto", fontSize: 11, color: "#ccc" }}>
        {tab === "history" &&
          mergedHistory.map((event, i) => (
            <div
              key={event.id || i}
              style={{
                padding: "6px 0",
                borderBottom: "1px solid rgba(255,255,255,0.05)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <span style={{ color: "#666" }}>
                  Day {event.gameDay} · {event.timeString || `T${event.gameTick}`}
                </span>
                <span style={{ color: typeColor(event.type), fontWeight: 600 }}>
                  {formatEventType(event.type)}
                </span>
              </div>
              <div style={{ color: "#ddd", lineHeight: 1.5 }}>
                {formatEventSummary(event, { characterNames, locationNames })}
              </div>
              {event.type === "dialogue" &&
                Array.isArray(event.data?.turns) &&
                event.data.turns.length > 0 && (
                  <div
                    style={{
                      marginTop: 6,
                      padding: "8px 10px",
                      background: "rgba(255,255,255,0.04)",
                      borderRadius: 6,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    {event.data.turns.map((turn: { speaker: string; content: string }, turnIndex: number) => (
                      <div key={turnIndex}>
                        <span style={{ color: "#74b9ff", fontWeight: 600 }}>
                          {characterNames[turn.speaker] || turn.speaker}
                        </span>
                        <div style={{ marginTop: 2, color: "#ddd", lineHeight: 1.5 }}>
                          {turn.content}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
            </div>
          ))}
        {tab === "relations" &&
          relations.map((r, i) => (
            <div key={i} style={{ padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              {r.targetName || r.targetId}: {r.label} ({relationStrength(r)}%)
            </div>
          ))}
        {tab === "memory" &&
          memories.map((m, i) => (
            <div key={i} style={{ padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              <span style={{ color: "#888" }}>[{m.type}]</span> {m.content}
            </div>
          ))}
        {((tab === "history" && mergedHistory.length === 0) ||
          (tab === "relations" && relations.length === 0) ||
          (tab === "memory" && memories.length === 0)) && (
          <div style={{ color: "#666", padding: 8, textAlign: "center" }}>暂无数据</div>
        )}
      </div>
    </div>
  );
}

function eventTouchesCharacter(event: SimulationEvent, charId: string): boolean {
  if (event.actorId === charId || event.targetId === charId) return true;
  if (Array.isArray(event.data?.turns)) {
    return event.data.turns.some((turn: { speaker: string }) => turn.speaker === charId);
  }
  return false;
}

function compareEventsDesc(a: SimulationEvent, b: SimulationEvent): number {
  if (a.gameDay !== b.gameDay) return b.gameDay - a.gameDay;
  if (a.gameTick !== b.gameTick) return b.gameTick - a.gameTick;
  return (b.createdAt || "").localeCompare(a.createdAt || "");
}

function typeColor(type: string): string {
  switch (type) {
    case "dialogue":
      return "#fdcb6e";
    case "movement":
      return "#74b9ff";
    case "action_start":
      return "#00b894";
    case "action_end":
      return "#95a5a6";
    default:
      return "#888";
  }
}

/* ── Profile Editor ── */

const PROFILE_FIELDS: { key: string; label: string; multiline?: boolean }[] = [
  { key: "coreTraits", label: "核心特质（逗号分隔）" },
  { key: "coreMotivation", label: "核心动机" },
  { key: "coreValues", label: "核心价值观（逗号分隔）" },
  { key: "speakingStyle", label: "说话风格" },
  { key: "fears", label: "恐惧（逗号分隔）" },
  { key: "backstory", label: "背景故事", multiline: true },
];

function ProfileEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  busy,
  flash,
}: {
  draft: Record<string, string>;
  onChange: (d: Record<string, string>) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  flash: string | null;
}) {
  const set = (key: string, val: string) => onChange({ ...draft, [key]: val });

  return (
    <div style={editorWrapStyle}>
      {PROFILE_FIELDS.map((f) =>
        f.multiline ? (
          <label key={f.key} style={fieldLabelStyle}>
            {f.label}
            <textarea
              value={draft[f.key] ?? ""}
              onChange={(e) => set(f.key, e.target.value)}
              rows={3}
              style={fieldTextareaStyle}
            />
          </label>
        ) : (
          <label key={f.key} style={fieldLabelStyle}>
            {f.label}
            <input
              value={draft[f.key] ?? ""}
              onChange={(e) => set(f.key, e.target.value)}
              style={fieldInputStyle}
            />
          </label>
        ),
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={onSave} disabled={busy} style={saveBtnStyle(busy)}>
          {busy ? "保存中…" : "保存"}
        </button>
        <button onClick={onCancel} disabled={busy} style={cancelBtnStyle}>取消</button>
        {flash && <span style={{ fontSize: 11, color: flash.startsWith("失败") ? "#ffb0b0" : "#8df3cf" }}>{flash}</span>}
      </div>
    </div>
  );
}

const editBtnStyle: CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#ccc",
  borderRadius: 4,
  padding: "2px 8px",
  cursor: "pointer",
  fontSize: 11,
  marginLeft: "auto",
};

const editorWrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "10px 0",
  marginBottom: 8,
  borderBottom: "1px solid rgba(255,255,255,0.08)",
};

const fieldLabelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  fontSize: 11,
  color: "#aaa",
};

const fieldInputStyle: CSSProperties = {
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 4,
  color: "#e8e8ea",
  padding: "4px 6px",
  fontSize: 12,
  fontFamily: "inherit",
};

const fieldTextareaStyle: CSSProperties = {
  ...fieldInputStyle,
  resize: "vertical",
};

function saveBtnStyle(busy: boolean): CSSProperties {
  return {
    background: busy ? "rgba(116,185,255,0.08)" : "rgba(116,185,255,0.2)",
    border: "1px solid rgba(116,185,255,0.45)",
    color: "#eaf5ff",
    borderRadius: 6,
    padding: "4px 14px",
    fontSize: 12,
    fontWeight: 600,
    cursor: busy ? "wait" : "pointer",
  };
}

const cancelBtnStyle: CSSProperties = {
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.12)",
  color: "#ccc",
  borderRadius: 6,
  padding: "4px 14px",
  fontSize: 12,
  cursor: "pointer",
};
