import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { apiClient } from "../services/api-client";
import type { CharacterInfo } from "../../types/api";

type TabKey = "broadcast" | "whisper" | "presets";

const PRESET_CARDS: Array<{ label: string; content: string; emoji: string; tone?: string }> = [
  { emoji: "☔", label: "下大雨", content: "天空忽然下起倾盆大雨，所有人都能听到雨砸在屋顶上的声音。", tone: "tense" },
  { emoji: "🔌", label: "停电了", content: "整个区域忽然陷入漆黑——停电了，只有零星的烛光和手机屏幕。", tone: "eerie" },
  { emoji: "🚪", label: "陌生人敲门", content: "一个没人认识的陌生人出现在门口，似乎在打听什么。", tone: "mysterious" },
  { emoji: "📜", label: "发现一封信", content: "有人在桌上发现了一封没有署名的信，内容让人心绪不宁。", tone: "ominous" },
  { emoji: "🌪️", label: "狂风大作", content: "狂风忽然席卷而来，外面的东西被吹得到处都是。", tone: "chaotic" },
  { emoji: "🐦", label: "诡异鸟群", content: "一群黑色的鸟在空中盘旋，久久不散，像是在盯着什么。", tone: "eerie" },
];

export function GodPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>("broadcast");
  const [characters, setCharacters] = useState<CharacterInfo[]>([]);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastBroadcastAt, setLastBroadcastAt] = useState<number | null>(null);

  const [broadcastContent, setBroadcastContent] = useState("");
  const [broadcastScope, setBroadcastScope] = useState("global");
  const [broadcastTone, setBroadcastTone] = useState("");

  const [whisperCharId, setWhisperCharId] = useState("");
  const [whisperContent, setWhisperContent] = useState("");
  const [whisperImportance, setWhisperImportance] = useState(8);
  const [whisperType, setWhisperType] = useState<"observation" | "dream" | "reflection" | "experience">("observation");

  useEffect(() => {
    apiClient
      .getCharacters()
      .then((list) => {
        setCharacters(list);
        if (list.length > 0) setWhisperCharId(list[0].id);
      })
      .catch((err) => {
        console.warn("[GodPanel] load characters failed", err);
      });
  }, []);

  const recentlyBroadcasted = useMemo(() => {
    if (!lastBroadcastAt) return false;
    return Date.now() - lastBroadcastAt < 30_000;
  }, [lastBroadcastAt]);

  const showFlash = (kind: "ok" | "err", text: string) => {
    setFlash({ kind, text });
    setTimeout(() => setFlash(null), 3500);
  };

  const doBroadcast = async (content: string, tone?: string, scope?: string) => {
    if (busy) return;
    const trimmed = content.trim();
    if (!trimmed) {
      showFlash("err", "内容不能为空");
      return;
    }
    setBusy(true);
    try {
      const resp = await apiClient.godBroadcast({
        content: trimmed,
        scope: scope || broadcastScope,
        tone: tone || broadcastTone || undefined,
      });
      showFlash("ok", `已广播给 ${resp.memoryWrittenTo} 位角色`);
      setLastBroadcastAt(Date.now());
      setBroadcastContent("");
    } catch (err) {
      showFlash("err", `失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const doWhisper = async () => {
    if (busy) return;
    if (!whisperCharId) {
      showFlash("err", "请选择角色");
      return;
    }
    const trimmed = whisperContent.trim();
    if (!trimmed) {
      showFlash("err", "内容不能为空");
      return;
    }
    setBusy(true);
    try {
      await apiClient.godWhisper({
        characterId: whisperCharId,
        content: trimmed,
        importance: whisperImportance,
        type: whisperType,
      });
      const charName = characters.find((c) => c.id === whisperCharId)?.name ?? whisperCharId;
      showFlash("ok", `已对"${charName}"植入记忆`);
      setWhisperContent("");
    } catch (err) {
      showFlash("err", `失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>👁️</span>
            <span style={{ fontWeight: 700, fontSize: 14 }}>上帝视角</span>
            <span style={{ opacity: 0.55, fontSize: 11 }}>
              向世界注入事件或记忆。LLM 会让角色"感知到"这些改变。
            </span>
          </div>
          <button onClick={onClose} style={closeBtnStyle}>×</button>
        </div>

        <div style={tabsStyle}>
          {(["broadcast", "presets", "whisper"] as TabKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={tabBtnStyle(tab === key)}
            >
              {key === "broadcast" ? "世界广播" : key === "presets" ? "灾难卡" : "耳语/托梦"}
            </button>
          ))}
        </div>

        <div style={bodyStyle}>
          {tab === "broadcast" && (
            <div style={sectionStyle}>
              <label style={labelStyle}>广播内容</label>
              <textarea
                value={broadcastContent}
                onChange={(e) => setBroadcastContent(e.target.value)}
                placeholder="例：天空忽然下起倾盆大雨……"
                rows={4}
                style={textareaStyle}
              />
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>范围</span>
                  <select
                    value={broadcastScope}
                    onChange={(e) => setBroadcastScope(e.target.value)}
                    style={selectStyle}
                  >
                    <option value="global">全世界</option>
                    <option value="main_area">main_area</option>
                  </select>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>氛围</span>
                  <input
                    type="text"
                    value={broadcastTone}
                    onChange={(e) => setBroadcastTone(e.target.value)}
                    placeholder="eerie / tense / joyful ..."
                    style={{ ...inputStyle, width: 180 }}
                  />
                </div>
              </div>
              {recentlyBroadcasted && (
                <div style={{ fontSize: 11, color: "#f7d08a" }}>
                  ⚠ 30 秒内刚刚广播过——频繁广播会稀释戏剧节奏。
                </div>
              )}
              <button
                onClick={() => doBroadcast(broadcastContent)}
                disabled={busy}
                style={primaryBtnStyle(busy)}
              >
                {busy ? "发送中..." : "向世界广播"}
              </button>
            </div>
          )}

          {tab === "presets" && (
            <div style={sectionStyle}>
              <div style={{ fontSize: 11, opacity: 0.7 }}>
                点一下立刻广播。建议配合对话进行中使用，戏剧效果更好。
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {PRESET_CARDS.map((card) => (
                  <button
                    key={card.label}
                    disabled={busy}
                    onClick={() => doBroadcast(card.content, card.tone)}
                    style={presetCardStyle(busy)}
                  >
                    <div style={{ fontSize: 18 }}>{card.emoji}</div>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{card.label}</div>
                    <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>{card.content}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {tab === "whisper" && (
            <div style={sectionStyle}>
              <label style={labelStyle}>耳语给谁</label>
              <select
                value={whisperCharId}
                onChange={(e) => setWhisperCharId(e.target.value)}
                style={selectStyle}
              >
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}（{c.id}）
                  </option>
                ))}
              </select>
              <label style={labelStyle}>内容（以"你"为主语，对角色说话）</label>
              <textarea
                value={whisperContent}
                onChange={(e) => setWhisperContent(e.target.value)}
                placeholder="例：你隐约记起，三天前在码头见过一个熟悉的身影……"
                rows={4}
                style={textareaStyle}
              />
              <div style={{ fontSize: 10, opacity: 0.45, marginTop: -4 }}>
                用"你"开头，角色会以为这是自己的回忆或感知。
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>重要性</span>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    value={whisperImportance}
                    onChange={(e) => setWhisperImportance(Number(e.target.value))}
                  />
                  <span style={{ fontSize: 11, minWidth: 16, textAlign: "right" }}>{whisperImportance}</span>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>类型</span>
                  <select
                    value={whisperType}
                    onChange={(e) => setWhisperType(e.target.value as typeof whisperType)}
                    style={selectStyle}
                  >
                    <option value="observation">observation（所见所闻）</option>
                    <option value="dream">dream（梦境）</option>
                    <option value="reflection">reflection（顿悟）</option>
                    <option value="experience">experience（亲身经历）</option>
                  </select>
                </div>
              </div>
              <button onClick={doWhisper} disabled={busy} style={primaryBtnStyle(busy)}>
                {busy ? "植入中..." : "植入记忆"}
              </button>
            </div>
          )}
        </div>

        {flash && (
          <div
            style={{
              ...flashStyle,
              background: flash.kind === "ok" ? "rgba(0,184,148,0.18)" : "rgba(231,76,60,0.22)",
              color: flash.kind === "ok" ? "#8df3cf" : "#ffb0b0",
              border: `1px solid ${flash.kind === "ok" ? "rgba(0,184,148,0.45)" : "rgba(231,76,60,0.45)"}`,
            }}
          >
            {flash.text}
          </div>
        )}
      </div>
    </div>
  );
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  top: "var(--top-ui-offset, 0px)",
  left: 0,
  right: 0,
  bottom: 0,
  background: "rgba(4,6,12,0.55)",
  zIndex: 500,
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "0 16px 16px",
  overflowY: "auto",
};

const panelStyle: CSSProperties = {
  width: "min(560px, calc(100% - 32px))",
  maxHeight: "calc(100vh - var(--top-ui-offset, 0px) - 16px)",
  background: "linear-gradient(180deg, rgba(16,20,36,0.98), rgba(12,14,26,0.98))",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 14,
  boxShadow: "0 28px 70px rgba(0,0,0,0.55)",
  color: "#e0e0e0",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
};

const headerStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
};

const closeBtnStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#e0e0e0",
  fontSize: 22,
  cursor: "pointer",
  lineHeight: 1,
  padding: 0,
  width: 28,
  height: 28,
  opacity: 0.7,
};

const tabsStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  padding: "10px 14px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

const bodyStyle: CSSProperties = {
  padding: 14,
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.75,
  letterSpacing: 0.2,
};

const textareaStyle: CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  color: "#e8e8ea",
  padding: "8px 10px",
  fontSize: 13,
  resize: "vertical",
  fontFamily: "inherit",
};

const inputStyle: CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 6,
  color: "#e8e8ea",
  padding: "4px 8px",
  fontSize: 12,
};

const selectStyle: CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: 6,
  color: "#e8e8ea",
  padding: "4px 8px",
  fontSize: 12,
};

const flashStyle: CSSProperties = {
  margin: "0 14px 14px",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 12,
};

function tabBtnStyle(active: boolean): CSSProperties {
  return {
    background: active ? "rgba(116,185,255,0.18)" : "rgba(255,255,255,0.04)",
    border: `1px solid ${active ? "rgba(116,185,255,0.45)" : "rgba(255,255,255,0.1)"}`,
    color: active ? "#dff3ff" : "#e0e0e0",
    borderRadius: 999,
    padding: "4px 12px",
    fontSize: 12,
    cursor: "pointer",
  };
}

function primaryBtnStyle(busy: boolean): CSSProperties {
  return {
    background: busy ? "rgba(116,185,255,0.1)" : "rgba(116,185,255,0.22)",
    border: "1px solid rgba(116,185,255,0.5)",
    color: "#eaf5ff",
    borderRadius: 8,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: busy ? "wait" : "pointer",
    alignSelf: "flex-start",
  };
}

function presetCardStyle(busy: boolean): CSSProperties {
  return {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 8,
    padding: "10px 12px",
    color: "#e0e0e0",
    textAlign: "left",
    cursor: busy ? "wait" : "pointer",
    opacity: busy ? 0.7 : 1,
    transition: "all 0.15s",
  };
}
