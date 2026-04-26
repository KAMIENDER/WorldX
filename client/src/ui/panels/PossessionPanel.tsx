import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { CharacterInfo } from "../../types/api";
import {
  apiClient,
  type PossessionActionOption,
  type PossessionChatMessage,
  type PossessionContext,
  type PossessionNearbyCharacter,
} from "../services/api-client";
import { formatActionName } from "../utils/event-format";

type EventBusLike = {
  emit(event: string, ...args: unknown[]): boolean;
};

type PossessionMode = "observe" | "control";

type LocalChatMessage = PossessionChatMessage & { pending?: boolean };

export function PossessionPanel({
  initialCharacterId,
  eventBus,
  onClose,
}: {
  initialCharacterId?: string | null;
  eventBus: EventBusLike;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<PossessionMode>("observe");
  const [characters, setCharacters] = useState<CharacterInfo[]>([]);
  const [characterId, setCharacterId] = useState(initialCharacterId ?? "");
  const [targetId, setTargetId] = useState("");
  const [context, setContext] = useState<PossessionContext | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionPair, setSessionPair] = useState<{ actorId: string; targetId: string } | null>(null);
  const [chatMessages, setChatMessages] = useState<LocalChatMessage[]>([]);
  const [chatContext, setChatContext] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [wakeTime, setWakeTime] = useState("07:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient.getCharacters()
      .then((list) => {
        if (cancelled) return;
        setCharacters(list);
        setCharacterId((current) => {
          if (current && list.some((character) => character.id === current)) return current;
          return initialCharacterId && list.some((character) => character.id === initialCharacterId)
            ? initialCharacterId
            : list[0]?.id ?? "";
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [initialCharacterId]);

  const refreshContext = useCallback(async () => {
    if (!characterId) return;
    const next = await apiClient.getPossessionContext({
      characterId,
      targetId: targetId || undefined,
    });
    setContext(next);
    setChatContext(next.recentDialogueContext ?? []);
    setTargetId((current) => {
      if (current && next.nearbyCharacters.some((character) => character.id === current)) return current;
      return next.nearbyCharacters[0]?.id ?? "";
    });
  }, [characterId, targetId]);

  useEffect(() => {
    let cancelled = false;
    if (!characterId) return;
    setError(null);
    apiClient.getPossessionContext({ characterId, targetId: targetId || undefined })
      .then((next) => {
        if (cancelled) return;
        setContext(next);
        setChatContext(next.recentDialogueContext ?? []);
        setTargetId((current) => {
          if (current && next.nearbyCharacters.some((character) => character.id === current)) return current;
          return next.nearbyCharacters[0]?.id ?? "";
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [characterId, targetId]);

  useEffect(() => {
    setSessionId(null);
    setSessionPair(null);
    setChatMessages([]);
    setDraft("");
  }, [characterId, targetId]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chatMessages]);

  const selectedTarget = useMemo(
    () => context?.nearbyCharacters.find((character) => character.id === targetId) ?? null,
    [context?.nearbyCharacters, targetId],
  );

  const activeCharacter = useMemo(
    () => characters.find((character) => character.id === characterId) ?? null,
    [characters, characterId],
  );

  const groupedActions = useMemo(() => {
    const groups = new Map<PossessionActionOption["category"], PossessionActionOption[]>();
    for (const action of context?.actions ?? []) {
      const bucket = groups.get(action.category) ?? [];
      bucket.push(action);
      groups.set(action.category, bucket);
    }
    return [...groups.entries()];
  }, [context?.actions]);

  const followCurrentCharacter = () => {
    if (!characterId) return;
    eventBus.emit("follow_character", characterId);
  };

  const performAction = async (action: PossessionActionOption) => {
    if (!characterId || busy || action.disabled) return;
    if (action.actionType === "talk_to") {
      setTargetId(action.targetId);
      setMode("control");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await apiClient.possessionAction({
        characterId,
        actionType: action.actionType,
        targetId: action.targetId,
        interactionId: action.interactionId,
        wakeTime: action.actionType === "sleep" ? wakeTime : undefined,
        reason: t("possession.actionReason"),
      });
      for (const event of response.events) {
        eventBus.emit("external_sim_event", event);
      }
      await refreshContext();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const ensureChatSession = async (): Promise<string | null> => {
    if (!characterId || !targetId) return null;
    if (sessionId && sessionPair?.actorId === characterId && sessionPair.targetId === targetId) {
      return sessionId;
    }
    const response = await apiClient.possessionChatStart({
      actorId: characterId,
      targetId,
    });
    setSessionId(response.sessionId);
    setSessionPair({ actorId: characterId, targetId });
    setChatMessages(response.history);
    setChatContext(response.contextLines);
    return response.sessionId;
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || !characterId || !targetId) return;
    const actorName = context?.actor.name ?? activeCharacter?.name ?? characterId;
    setDraft("");
    setBusy(true);
    setError(null);
    setChatMessages((current) => [
      ...current,
      { speakerId: characterId, speakerName: actorName, content: text },
      { speakerId: targetId, speakerName: selectedTarget?.name ?? targetId, content: "…", pending: true },
    ]);
    try {
      const activeSessionId = await ensureChatSession();
      if (!activeSessionId) throw new Error("chat target is required");
      const response = await apiClient.possessionChatSend({
        sessionId: activeSessionId,
        message: text,
      });
      setChatMessages(response.history);
      if (response.event) {
        eventBus.emit("external_sim_event", response.event);
      }
      await refreshContext();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setChatMessages((current) => current.filter((entry) => !entry.pending));
    } finally {
      setBusy(false);
    }
  };

  const closePanel = async () => {
    if (sessionId) {
      try {
        await apiClient.possessionChatClose(sessionId);
      } catch {
        // best effort
      }
    }
    onClose();
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div style={backdropStyle} onClick={closePanel}>
      <section style={panelStyle} onClick={(event) => event.stopPropagation()}>
        <header style={headerStyle}>
          <div>
            <div style={kickerStyle}>{t("possession.kicker")}</div>
            <h2 style={titleStyle}>{t("possession.title")}</h2>
          </div>
          <button type="button" onClick={closePanel} style={closeButtonStyle}>
            ×
          </button>
        </header>

        <div style={controlStripStyle}>
          <select
            value={characterId}
            onChange={(event) => setCharacterId(event.target.value)}
            style={selectStyle}
          >
            {characters.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name} · {character.role}
              </option>
            ))}
          </select>
          <div style={modeSwitchStyle}>
            <button type="button" onClick={() => setMode("observe")} style={modeButtonStyle(mode === "observe")}>
              {t("possession.observe")}
            </button>
            <button type="button" onClick={() => setMode("control")} style={modeButtonStyle(mode === "control")}>
              {t("possession.control")}
            </button>
          </div>
        </div>

        {context ? (
          <div style={bodyStyle}>
            <aside style={statusColumnStyle}>
              <div style={identityCardStyle}>
                <div style={characterNameStyle}>{context.actor.name}</div>
                <div style={mutedTextStyle}>{context.actor.role}</div>
                <div style={locationTextStyle}>
                  {context.location.name}
                  {context.location.zone ? ` · ${context.location.zone}` : ""}
                </div>
                <div style={meterGridStyle}>
                  <Metric label={t("possession.energy")} value={Math.round(context.state.energy)} />
                  <Metric label={t("possession.hunger")} value={Math.round(context.state.hunger)} />
                  <Metric label={t("possession.stress")} value={Math.round(context.state.stress)} />
                </div>
                <button type="button" onClick={followCurrentCharacter} style={secondaryButtonStyle}>
                  {t("possession.followCamera")}
                </button>
              </div>

              <div style={sectionStyle}>
                <div style={sectionTitleStyle}>{t("possession.environment")}</div>
                {(context.recentEnvironmentChanges.length > 0 ? context.recentEnvironmentChanges : [context.location.description || t("possession.noContext")])
                  .slice(0, 4)
                  .map((line, index) => (
                    <div key={index} style={contextLineStyle}>{line}</div>
                  ))}
              </div>

              <div style={sectionStyle}>
                <div style={sectionTitleStyle}>{t("possession.nearby")}</div>
                {context.nearbyCharacters.length === 0 ? (
                  <div style={mutedTextStyle}>{t("possession.noNearby")}</div>
                ) : (
                  context.nearbyCharacters.map((character) => (
                    <button
                      key={character.id}
                      type="button"
                      onClick={() => {
                        setTargetId(character.id);
                        setMode("control");
                      }}
                      style={nearbyButtonStyle(character.id === targetId)}
                    >
                      <span>{character.name}</span>
                      <span style={nearbyMetaStyle}>
                        {character.currentAction ? formatActionName(character.currentAction) : t("possession.available")}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </aside>

            <main style={mainColumnStyle}>
              {mode === "observe" ? (
                <ObserveSurface context={context} t={t} />
              ) : (
                <>
                  <section style={sectionStyle}>
                    <div style={sectionHeaderStyle}>
                      <div style={sectionTitleStyle}>{t("possession.actions")}</div>
                      <label style={wakeTimeStyle}>
                        {t("possession.wakeTime")}
                        <input
                          value={wakeTime}
                          onChange={(event) => setWakeTime(event.target.value)}
                          style={timeInputStyle}
                          type="time"
                        />
                      </label>
                    </div>
                    <div style={actionGroupsStyle}>
                      {groupedActions.map(([category, actions]) => (
                        <div key={category} style={actionGroupStyle}>
                          <div style={actionCategoryStyle}>{t(`possession.category.${category}`)}</div>
                          <div style={actionGridStyle}>
                            {actions.map((action) => (
                              <button
                                key={action.id}
                                type="button"
                                disabled={busy || action.disabled}
                                onClick={() => void performAction(action)}
                                style={actionButtonStyle(busy || !!action.disabled)}
                              >
                                {action.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section style={chatSectionStyle}>
                    <div style={sectionHeaderStyle}>
                      <div>
                        <div style={sectionTitleStyle}>{t("possession.dialogue")}</div>
                        <div style={mutedTextStyle}>
                          {selectedTarget ? t("possession.talkingTo", { name: selectedTarget.name }) : t("possession.noChatTarget")}
                        </div>
                      </div>
                      {context.nearbyCharacters.length > 0 && (
                        <select value={targetId} onChange={(event) => setTargetId(event.target.value)} style={smallSelectStyle}>
                          {context.nearbyCharacters.map((character) => (
                            <option key={character.id} value={character.id}>{character.name}</option>
                          ))}
                        </select>
                      )}
                    </div>

                    <div style={historyContextStyle}>
                      <div style={historyTitleStyle}>{t("possession.historyContext")}</div>
                      {chatContext.length === 0 ? (
                        <span style={mutedTextStyle}>{t("possession.noHistoryContext")}</span>
                      ) : (
                        chatContext.slice(-6).map((line, index) => (
                          <span key={index} style={historyLineStyle}>{line}</span>
                        ))
                      )}
                    </div>

                    <div ref={scrollRef} style={chatScrollStyle}>
                      {chatMessages.length === 0 ? (
                        <div style={emptyChatStyle}>{t("possession.emptyChat")}</div>
                      ) : (
                        chatMessages.map((message, index) => {
                          const mine = message.speakerId === characterId;
                          return (
                            <div key={`${message.speakerId}:${index}`} style={messageRowStyle(mine)}>
                              <div style={bubbleStyle(mine, message.pending)}>
                                <strong>{message.speakerName}</strong>
                                <span>{message.content}</span>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    <div style={inputRowStyle}>
                      <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={onKey}
                        disabled={busy || !targetId}
                        placeholder={t("possession.chatPlaceholder")}
                        rows={2}
                        style={textareaStyle}
                      />
                      <button
                        type="button"
                        onClick={() => void send()}
                        disabled={busy || !targetId || !draft.trim()}
                        style={sendButtonStyle(busy || !targetId || !draft.trim())}
                      >
                        {busy ? "…" : t("possession.send")}
                      </button>
                    </div>
                  </section>
                </>
              )}
            </main>
          </div>
        ) : (
          <div style={loadingStyle}>{t("possession.loading")}</div>
        )}

        {error && <div style={errorStyle}>{error}</div>}
      </section>
    </div>
  );
}

function ObserveSurface({
  context,
  t,
}: {
  context: PossessionContext;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  return (
    <section style={observeSurfaceStyle}>
      <div style={observeTitleStyle}>{t("possession.observeTitle", { name: context.actor.name })}</div>
      <div style={observeCopyStyle}>{t("possession.observeCopy")}</div>
      <div style={observeGridStyle}>
        <div>
          <div style={sectionTitleStyle}>{t("possession.currentAction")}</div>
          <div style={largeValueStyle}>
            {context.state.currentActionLabel || (context.state.currentAction ? formatActionName(context.state.currentAction) : t("possession.available"))}
          </div>
        </div>
        <div>
          <div style={sectionTitleStyle}>{t("possession.recentActions")}</div>
          {(context.recentActions.length > 0 ? context.recentActions : [t("possession.noRecentActions")]).slice(0, 4).map((line, index) => (
            <div key={index} style={contextLineStyle}>{line}</div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div style={metricStyle}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 560,
  pointerEvents: "auto",
  display: "flex",
  justifyContent: "flex-end",
  alignItems: "stretch",
  padding: "calc(var(--hud-safe-top, 92px) + 8px) 14px 14px",
  background: "linear-gradient(90deg, rgba(0,0,0,0.16), rgba(0,0,0,0.5))",
};

const panelStyle: CSSProperties = {
  width: "min(760px, 100%)",
  maxWidth: "calc(100vw - 28px)",
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  color: "var(--hud-text)",
  background: "linear-gradient(180deg, rgba(12,12,12,0.96), rgba(5,5,5,0.9)), var(--hud-stripe)",
  borderLeft: "5px solid var(--hud-gold)",
  borderTop: "1px solid rgba(255,255,255,0.2)",
  borderRight: "1px solid rgba(255,255,255,0.14)",
  borderBottom: "1px solid rgba(255,255,255,0.14)",
  boxShadow: "var(--hud-shadow)",
  clipPath: "var(--hud-cut-corners)",
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  padding: "15px 16px 10px",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
};

const kickerStyle: CSSProperties = {
  color: "var(--hud-blue)",
  fontSize: 11,
  fontWeight: 950,
};

const titleStyle: CSSProperties = {
  margin: "3px 0 0",
  color: "var(--hud-text)",
  fontSize: 22,
  lineHeight: 1.1,
  fontWeight: 950,
};

const closeButtonStyle: CSSProperties = {
  width: 32,
  height: 32,
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(255,255,255,0.06)",
  color: "var(--hud-text)",
  fontSize: 24,
  lineHeight: 1,
  cursor: "pointer",
  clipPath: "var(--hud-cut-corners)",
};

const controlStripStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
  padding: "12px 16px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
};

const selectStyle: CSSProperties = {
  flex: "1 1 260px",
  minHeight: 40,
  minWidth: 0,
  background: "rgba(0,0,0,0.38)",
  color: "var(--hud-text)",
  border: "1px solid rgba(255,255,255,0.18)",
  padding: "0 10px",
  fontWeight: 850,
  clipPath: "var(--hud-cut-corners)",
};

const smallSelectStyle: CSSProperties = {
  ...selectStyle,
  flex: "0 1 170px",
  minHeight: 34,
  fontSize: 12,
};

const modeSwitchStyle: CSSProperties = {
  display: "flex",
  gap: 6,
};

const bodyStyle: CSSProperties = {
  minHeight: 0,
  flex: 1,
  display: "grid",
  gridTemplateColumns: "250px minmax(0, 1fr)",
  gap: 12,
  padding: 14,
  overflow: "hidden",
};

const statusColumnStyle: CSSProperties = {
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  overflowY: "auto",
  paddingRight: 2,
};

const mainColumnStyle: CSSProperties = {
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  overflow: "hidden",
};

const identityCardStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  padding: 12,
  background: "rgba(255,216,77,0.1)",
  border: "1px solid rgba(255,216,77,0.32)",
  clipPath: "var(--hud-cut-corners)",
};

const characterNameStyle: CSSProperties = {
  color: "var(--hud-paper)",
  fontSize: 20,
  fontWeight: 950,
  lineHeight: 1.1,
};

const locationTextStyle: CSSProperties = {
  color: "var(--hud-blue)",
  fontSize: 12,
  fontWeight: 900,
};

const mutedTextStyle: CSSProperties = {
  color: "var(--hud-muted)",
  fontSize: 12,
  lineHeight: 1.45,
  fontWeight: 750,
};

const meterGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 6,
};

const metricStyle: CSSProperties = {
  minHeight: 46,
  display: "grid",
  alignContent: "center",
  gap: 2,
  padding: "6px 7px",
  background: "rgba(0,0,0,0.26)",
  border: "1px solid rgba(255,255,255,0.1)",
  fontSize: 10,
  color: "var(--hud-muted)",
  clipPath: "var(--hud-cut-corners)",
};

const secondaryButtonStyle: CSSProperties = {
  minHeight: 34,
  border: "1px solid rgba(68,216,255,0.4)",
  background: "rgba(68,216,255,0.1)",
  color: "var(--hud-blue)",
  fontSize: 12,
  fontWeight: 950,
  cursor: "pointer",
  clipPath: "var(--hud-cut-corners)",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 11,
  background: "rgba(255,255,255,0.055)",
  border: "1px solid rgba(255,255,255,0.12)",
  clipPath: "var(--hud-cut-corners)",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 10,
  alignItems: "flex-start",
};

const sectionTitleStyle: CSSProperties = {
  color: "var(--hud-gold)",
  fontSize: 12,
  fontWeight: 950,
};

const contextLineStyle: CSSProperties = {
  color: "var(--hud-muted)",
  fontSize: 12,
  lineHeight: 1.45,
};

const nearbyButtonStyle = (active: boolean): CSSProperties => ({
  minHeight: 42,
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  alignItems: "center",
  padding: "8px 9px",
  border: active ? "1px solid rgba(255,216,77,0.58)" : "1px solid rgba(255,255,255,0.12)",
  borderLeft: active ? "4px solid var(--hud-gold)" : "4px solid rgba(255,255,255,0.12)",
  background: active ? "rgba(255,216,77,0.14)" : "rgba(0,0,0,0.24)",
  color: "var(--hud-text)",
  cursor: "pointer",
  clipPath: "var(--hud-cut-corners)",
});

const nearbyMetaStyle: CSSProperties = {
  color: "var(--hud-muted)",
  fontSize: 11,
  whiteSpace: "nowrap",
};

const observeSurfaceStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: 16,
  background: "linear-gradient(180deg, rgba(68,216,255,0.08), rgba(0,0,0,0.22))",
  border: "1px solid rgba(68,216,255,0.22)",
  clipPath: "var(--hud-cut-corners)",
};

const observeTitleStyle: CSSProperties = {
  color: "var(--hud-paper)",
  fontSize: 26,
  fontWeight: 950,
};

const observeCopyStyle: CSSProperties = {
  color: "var(--hud-muted)",
  fontSize: 14,
  lineHeight: 1.55,
  fontWeight: 780,
};

const observeGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 12,
};

const largeValueStyle: CSSProperties = {
  marginTop: 8,
  color: "var(--hud-text)",
  fontSize: 18,
  fontWeight: 950,
};

const wakeTimeStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  color: "var(--hud-muted)",
  fontSize: 11,
  fontWeight: 850,
};

const timeInputStyle: CSSProperties = {
  width: 88,
  minHeight: 28,
  background: "rgba(0,0,0,0.36)",
  color: "var(--hud-text)",
  border: "1px solid rgba(255,255,255,0.16)",
  padding: "0 6px",
};

const actionGroupsStyle: CSSProperties = {
  maxHeight: 180,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  paddingRight: 2,
};

const actionGroupStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const actionCategoryStyle: CSSProperties = {
  color: "var(--hud-blue)",
  fontSize: 11,
  fontWeight: 950,
};

const actionGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(128px, 1fr))",
  gap: 7,
};

const actionButtonStyle = (disabled: boolean): CSSProperties => ({
  minHeight: 36,
  padding: "7px 9px",
  border: "1px solid rgba(255,255,255,0.14)",
  background: disabled ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.32)",
  color: disabled ? "var(--hud-dim)" : "var(--hud-text)",
  fontSize: 12,
  fontWeight: 850,
  cursor: disabled ? "default" : "pointer",
  textAlign: "left",
  clipPath: "var(--hud-cut-corners)",
});

const chatSectionStyle: CSSProperties = {
  ...sectionStyle,
  flex: 1,
  minHeight: 0,
};

const historyContextStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  maxHeight: 74,
  overflowY: "auto",
  padding: "8px 9px",
  background: "rgba(0,0,0,0.28)",
  border: "1px solid rgba(255,255,255,0.1)",
};

const historyTitleStyle: CSSProperties = {
  color: "var(--hud-blue)",
  fontSize: 11,
  fontWeight: 950,
};

const historyLineStyle: CSSProperties = {
  color: "var(--hud-muted)",
  fontSize: 11,
  lineHeight: 1.35,
};

const chatScrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 150,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 7,
  padding: "8px 2px",
};

const emptyChatStyle: CSSProperties = {
  color: "var(--hud-muted)",
  fontSize: 12,
  textAlign: "center",
  padding: 16,
};

const messageRowStyle = (mine: boolean): CSSProperties => ({
  display: "flex",
  justifyContent: mine ? "flex-end" : "flex-start",
});

const bubbleStyle = (mine: boolean, pending?: boolean): CSSProperties => ({
  maxWidth: "82%",
  display: "grid",
  gap: 4,
  padding: "8px 10px",
  color: mine ? "var(--hud-ink)" : "var(--hud-text)",
  background: mine ? "var(--hud-gold)" : "rgba(255,255,255,0.08)",
  border: mine ? "0" : "1px solid rgba(255,255,255,0.12)",
  fontSize: 12,
  lineHeight: 1.45,
  opacity: pending ? 0.7 : 1,
  clipPath: "var(--hud-cut-corners)",
});

const inputRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-end",
};

const textareaStyle: CSSProperties = {
  flex: 1,
  minHeight: 48,
  resize: "vertical",
  background: "rgba(0,0,0,0.38)",
  color: "var(--hud-text)",
  border: "1px solid rgba(255,255,255,0.14)",
  padding: "8px 9px",
  fontFamily: "inherit",
  fontSize: 13,
};

const sendButtonStyle = (disabled: boolean): CSSProperties => ({
  minHeight: 48,
  padding: "0 16px",
  border: "0",
  background: disabled ? "rgba(255,255,255,0.1)" : "var(--hud-gold)",
  color: disabled ? "var(--hud-dim)" : "var(--hud-ink)",
  fontWeight: 950,
  cursor: disabled ? "default" : "pointer",
  clipPath: "var(--hud-cut-corners)",
});

const modeButtonStyle = (active: boolean): CSSProperties => ({
  minHeight: 40,
  padding: "0 13px",
  border: active ? "1px solid var(--hud-gold)" : "1px solid rgba(255,255,255,0.15)",
  background: active ? "var(--hud-gold)" : "rgba(255,255,255,0.06)",
  color: active ? "var(--hud-ink)" : "var(--hud-text)",
  fontSize: 12,
  fontWeight: 950,
  cursor: "pointer",
  clipPath: "var(--hud-cut-corners)",
});

const loadingStyle: CSSProperties = {
  minHeight: 220,
  display: "grid",
  placeItems: "center",
  color: "var(--hud-muted)",
};

const errorStyle: CSSProperties = {
  margin: "0 14px 14px",
  padding: "9px 10px",
  color: "#ffbcc2",
  background: "rgba(255,79,94,0.12)",
  border: "1px solid rgba(255,79,94,0.36)",
  fontSize: 12,
  fontWeight: 800,
  clipPath: "var(--hud-cut-corners)",
};
