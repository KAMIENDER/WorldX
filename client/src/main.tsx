import Phaser from "phaser";
import { createRoot } from "react-dom/client";
import { BootScene } from "./scenes/BootScene";
import { WorldScene } from "./scenes/WorldScene";
import { App } from "./ui/App";
import { EventBus } from "./EventBus";

const game = new Phaser.Game({
  type: Phaser.AUTO,
  width: window.innerWidth,
  height: window.innerHeight,
  parent: "game-root",
  render: { antialias: true, roundPixels: true },
  scale: { mode: Phaser.Scale.RESIZE },
  scene: [BootScene, WorldScene],
  backgroundColor: "#1a1a2e",
});

const uiRoot = document.getElementById("ui-root")!;
createRoot(uiRoot).render(<App eventBus={EventBus.instance} />);
