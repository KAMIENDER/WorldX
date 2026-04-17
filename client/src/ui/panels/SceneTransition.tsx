import { useEffect, useState } from "react";

export function SceneTransition({
  day,
  visible,
  title,
  timeString,
  periodLabel,
  variant = "open",
  onComplete,
}: {
  day: number;
  visible: boolean;
  title?: string;
  timeString?: string;
  periodLabel?: string;
  variant?: "open" | "closed";
  onComplete?: () => void;
}) {
  const [opacity, setOpacity] = useState(0);
  const [contentOffset, setContentOffset] = useState(20);

  useEffect(() => {
    if (!visible) {
      setOpacity(0);
      setContentOffset(20);
      return;
    }

    setOpacity(1);
    setContentOffset(0);
    const timer = setTimeout(() => {
      setOpacity(0);
      setContentOffset(-10);
      const fadeTimer = setTimeout(() => onComplete?.(), 1500);
      return () => clearTimeout(fadeTimer);
    }, 3000);
    return () => clearTimeout(timer);
  }, [visible, day, onComplete]);

  if (!visible && opacity === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background:
          variant === "open"
            ? "radial-gradient(circle at 50% 35%, rgba(72,112,180,0.2), rgba(8,10,18,0.96) 58%, rgba(4,6,12,0.98))"
            : "rgba(10, 10, 20, 0.95)",
        opacity,
        transition: "opacity 1.5s ease-in-out",
        pointerEvents: visible ? "auto" : "none",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            variant === "open"
              ? "linear-gradient(180deg, rgba(255,255,255,0.03), transparent 30%, rgba(255,255,255,0.02) 68%, transparent)"
              : "transparent",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: "min(72vw, 760px)",
          height: 160,
          transform: "translate(-50%, -50%)",
          background:
            variant === "open"
              ? "linear-gradient(90deg, transparent, rgba(196,223,255,0.18), rgba(138,188,255,0.26), rgba(196,223,255,0.18), transparent)"
              : "linear-gradient(90deg, transparent, rgba(156,201,255,0.12), transparent)",
          filter: "blur(30px)",
          opacity: opacity * 0.9,
        }}
      />
      <div
        style={{
          position: "relative",
          transform: `translateY(${contentOffset}px)`,
          transition: "transform 1.5s ease",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "32px 40px",
          borderRadius: 24,
          backdropFilter: "blur(6px)",
          background: "rgba(10, 14, 24, 0.18)",
          border: "1px solid rgba(255,255,255,0.06)",
          boxShadow: "0 18px 60px rgba(0,0,0,0.28)",
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 500,
            color: "#9cc9ff",
            letterSpacing: 6,
            marginBottom: 18,
            textAlign: "center",
          }}
        >
          {title || "新的一段时间开始了"}
        </div>
        <div
          style={{
            fontSize: 48,
            fontWeight: 300,
            color: "#e0e0e0",
            letterSpacing: 4,
            marginBottom: 18,
            textAlign: "center",
          }}
        >
          第 {day} 天
        </div>
        {(timeString || periodLabel) && (
          <div
            style={{
              color: "rgba(224, 224, 224, 0.78)",
              fontSize: 18,
              letterSpacing: 2,
              marginBottom: 18,
            }}
          >
            {[timeString, periodLabel].filter(Boolean).join(" · ")}
          </div>
        )}
        <div
          style={{
            width: 60,
            height: 2,
            background: "linear-gradient(90deg, transparent, #74b9ff, transparent)",
          }}
        />
      </div>
      <div
        style={{
          position: "absolute",
          inset: "auto 0 12% 0",
          display: "flex",
          justifyContent: "center",
          opacity: 0.35,
        }}
      >
        <div
          style={{
            width: "min(80vw, 680px)",
            height: 1,
            background:
              "linear-gradient(90deg, transparent, rgba(255,255,255,0.28), transparent)",
          }}
        />
      </div>
    </div>
  );
}
