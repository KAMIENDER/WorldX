import { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import Phaser from "phaser";

interface CameraState {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number;
  mapWidth: number;
  mapHeight: number;
}

const MINI_W = 200;
const MINI_W_COMPACT = 160;
const MINI_MAP_IMAGE_PATH = "/assets/map/06-background.png";

export function MapControls({
  eventBus,
  presentationMode = false,
}: {
  eventBus: Phaser.Events.EventEmitter;
  presentationMode?: boolean;
}) {
  const { t } = useTranslation();
  const miniWidth = presentationMode ? MINI_W_COMPACT : MINI_W;
  const [zoom, setZoom] = useState(1);
  const [showHint, setShowHint] = useState(!presentationMode);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef<CameraState>({ x: 0, y: 0, width: 1024, height: 768, zoom: 1, mapWidth: 8192, mapHeight: 4608 });
  const rafRef = useRef(0);
  const miniHRef = useRef(Math.round(miniWidth * (4608 / 8192)));
  const miniMapImageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    setShowHint(!presentationMode);
  }, [presentationMode]);

  useEffect(() => {
    const onZoom = (z: number) => setZoom(z);
    const onCamState = (s: CameraState) => {
      camRef.current = s;
      if (s.mapWidth > 0 && s.mapHeight > 0) {
        miniHRef.current = Math.round(miniWidth * (s.mapHeight / s.mapWidth));
      }
    };

    eventBus.on("camera_zoom_changed", onZoom);
    eventBus.on("camera_state", onCamState);

    const timer = presentationMode
      ? null
      : setTimeout(() => setShowHint(false), 9000);

    return () => {
      eventBus.off("camera_zoom_changed", onZoom);
      eventBus.off("camera_state", onCamState);
      if (timer) clearTimeout(timer);
      cancelAnimationFrame(rafRef.current);
    };
  }, [eventBus, miniWidth, presentationMode]);

  useEffect(() => {
    const image = new Image();
    image.src = MINI_MAP_IMAGE_PATH;
    image.onload = () => {
      miniMapImageRef.current = image;
    };
    image.onerror = () => {
      miniMapImageRef.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const cam = camRef.current;
      const mapW = cam.mapWidth || 8192;
      const mapH = cam.mapHeight || 4608;
      const miniH = miniHRef.current;
      const scale = miniWidth / mapW;
      const minimapImage = miniMapImageRef.current;

      canvas.height = miniH;
      ctx.clearRect(0, 0, miniWidth, miniH);

      if (minimapImage?.complete && minimapImage.naturalWidth > 0) {
        ctx.drawImage(minimapImage, 0, 0, miniWidth, miniH);
      } else {
        ctx.fillStyle = "#1a1a2e";
        ctx.fillRect(0, 0, miniWidth, miniH);
      }

      const vx = cam.x * scale;
      const vy = cam.y * scale;
      const vw = cam.width * scale;
      const vh = cam.height * scale;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        Math.max(0, vx),
        Math.max(0, vy),
        Math.min(miniWidth - Math.max(0, vx), vw),
        Math.min(miniH - Math.max(0, vy), vh)
      );

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [miniWidth]);

  const handleMinimapClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const mapW = camRef.current.mapWidth || 8192;
      const scale = miniWidth / mapW;
      const worldX = mx / scale;
      const worldY = my / scale;
      eventBus.emit("camera_pan_to", { x: worldX, y: worldY });
    },
    [eventBus, miniWidth]
  );

  const [draggingMinimap, setDraggingMinimap] = useState(false);

  const handleMinimapDrag = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!draggingMinimap) return;
      handleMinimapClick(e);
    },
    [draggingMinimap, handleMinimapClick]
  );

  const zoomIn = useCallback(() => eventBus.emit("camera_zoom_in"), [eventBus]);
  const zoomOut = useCallback(() => eventBus.emit("camera_zoom_out"), [eventBus]);
  const zoomFit = useCallback(() => eventBus.emit("camera_zoom_fit"), [eventBus]);
  const zoomReset = useCallback(() => eventBus.emit("camera_zoom_reset"), [eventBus]);

  return (
    <>
      {/* Bottom-left: Minimap + Zoom */}
      <div style={{ position: "fixed", bottom: 14, left: 14, zIndex: 95, pointerEvents: "auto" }}>
        <div style={mapDockStyle}>
          <div style={mapDockHeaderStyle}>
            <span style={{ color: "var(--hud-ink)", background: "var(--hud-gold)", padding: "3px 8px", borderRadius: 2, fontWeight: 950, letterSpacing: 0, textTransform: "uppercase", clipPath: "var(--hud-cut-corners)" }}>地图</span>
            <span style={{ color: "var(--hud-muted)", fontWeight: 750 }}>{Math.round(zoom * 100)}%</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 7 }}>
          <ZoomBtn onClick={zoomOut} title={t("mapControls.zoomOut")}>−</ZoomBtn>
          <div
            onClick={zoomReset}
            title={t("mapControls.zoomReset")}
            style={{ flex: 1, textAlign: "center", fontSize: 11, color: "var(--hud-muted)", cursor: "pointer", userSelect: "none", fontWeight: 850 }}
          >
            {t("mapControls.zoomReset")}
          </div>
          <ZoomBtn onClick={zoomIn} title={t("mapControls.zoomIn")}>+</ZoomBtn>
          <Divider />
          <ZoomBtn onClick={zoomFit} title={t("mapControls.zoomFit")}>⊡</ZoomBtn>

          </div>
          <canvas
            ref={canvasRef}
            width={miniWidth}
            height={Math.round(miniWidth * (4608 / 8192))}
            style={minimapCanvasStyle}
            onClick={handleMinimapClick}
            onMouseDown={() => setDraggingMinimap(true)}
            onMouseUp={() => setDraggingMinimap(false)}
            onMouseLeave={() => setDraggingMinimap(false)}
            onMouseMove={handleMinimapDrag}
          />
        </div>
      </div>

      {/* Controls hint - bottom center, fades out */}
      {!presentationMode && showHint && (
        <div
          style={{
            position: "fixed",
            bottom: 232,
            left: 14,
            background: "rgba(8, 8, 8, 0.88)",
            backdropFilter: "blur(10px) saturate(1.04)",
            borderRadius: 4,
            padding: "10px 14px",
            color: "var(--hud-text)",
            fontSize: 12,
            zIndex: 80,
            pointerEvents: "none",
            animation: "hintFade 9s ease forwards",
            border: "1px solid rgba(255,255,255,0.18)",
            borderLeft: "4px solid var(--hud-gold)",
            boxShadow: "var(--hud-shadow)",
            width: "min(340px, calc(100vw - 28px))",
            clipPath: "var(--hud-cut-corners)",
          }}
        >
          <div style={{ fontWeight: 950, fontSize: 12, marginBottom: 4, color: "var(--hud-gold)", letterSpacing: 0 }}>
            {t("mapControls.hintTitle")}
          </div>
          <div>{t("mapControls.hintLine1")}</div>
          <div style={{ marginTop: 2 }}>{t("mapControls.hintLine2")}</div>
          <style>{`
            @keyframes hintFade {
              0%, 78% { opacity: 1; }
              100% { opacity: 0; }
            }
          `}</style>
        </div>
      )}
    </>
  );
}

function ZoomBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 28, height: 28, borderRadius: 2,
        border: "1px solid rgba(255,255,255,0.16)",
        background: "rgba(255,255,255,0.08)",
        color: "var(--hud-text)", fontSize: 15, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontWeight: 950,
        boxShadow: "3px 3px 0 rgba(0,0,0,0.24)",
        clipPath: "var(--hud-cut-corners)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--hud-gold)";
        e.currentTarget.style.color = "var(--hud-ink)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.08)";
        e.currentTarget.style.color = "var(--hud-text)";
      }}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.12)" }} />;
}

const mapDockStyle: React.CSSProperties = {
  width: 222,
  padding: 9,
  borderRadius: 4,
  background: "linear-gradient(180deg, rgba(12,12,12,0.92), rgba(5,5,5,0.82)), var(--hud-stripe)",
  backdropFilter: "blur(10px) saturate(1.04)",
  border: "1px solid rgba(255,255,255,0.18)",
  borderTop: "4px solid var(--hud-gold)",
  boxShadow: "var(--hud-shadow)",
  clipPath: "var(--hud-cut-corners)",
};

const mapDockHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 7,
  fontSize: 10,
};

const minimapCanvasStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  borderRadius: 2,
  cursor: "crosshair",
  border: "1px solid rgba(255,255,255,0.18)",
  boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.24), 3px 3px 0 rgba(0,0,0,0.28)",
};
