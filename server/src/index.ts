import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { appContext } from "./services/app-context.js";
import { setupWebSocket } from "./api/websocket.js";

import worldRoutes from "./api/routes/world.js";
import characterRoutes from "./api/routes/characters.js";
import eventsRoutes from "./api/routes/events.js";
import graphRoutes from "./api/routes/graph.js";
import { createPublicContentRouter } from "./api/routes/content.js";
import simulationRoutes from "./api/routes/simulation.js";
import godRoutes from "./api/routes/god.js";
import sandboxChatRoutes from "./api/routes/sandbox-chat.js";
import { resolveInitialWorldDir } from "./utils/world-directories.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function createWorldAssetHandler(assetDirName: "map" | "characters"): express.RequestHandler {
  return (req, res, next) => {
    const worldDir = appContext.getWorldDir();
    if (!worldDir) {
      res.status(404).end();
      return;
    }

    const relativePath = decodeURIComponent(req.path).replace(/^\/+/, "");
    if (!relativePath) {
      res.status(404).end();
      return;
    }

    res.sendFile(relativePath, {
      root: path.join(worldDir, assetDirName),
      dotfiles: "deny",
    }, (error) => {
      if (!error) return;
      const assetError = error as NodeJS.ErrnoException & { status?: number };
      if (res.headersSent) {
        next(assetError);
        return;
      }
      if (assetError.status === 404) {
        res.status(404).end();
        return;
      }
      next(assetError);
    });
  };
}

async function main() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const worldDir = resolveInitialWorldDir();
  console.log(`[WorldSeed] World dir: ${worldDir ?? "using default configs"}`);

  await appContext.initialize(worldDir);
  console.log("[WorldSeed] All systems initialized");

  app.get("/api/health", (_req, res) => {
    const wm = appContext.worldManager;
    res.json({
      status: "ok",
      project: "world-seed",
      worldName: wm.getWorldName(),
      sceneConfig: wm.getSceneConfig(),
    });
  });

  app.use("/api/world", worldRoutes);
  app.use("/api/characters", characterRoutes);
  app.use("/api/events", eventsRoutes);
  app.use("/api/graph", graphRoutes);
  app.use("/api/content", createPublicContentRouter());
  app.use("/api/simulation", simulationRoutes);
  app.use("/api/god", godRoutes);
  app.use("/api/sandbox/chat", sandboxChatRoutes);

  app.use("/assets/map", createWorldAssetHandler("map"));
  app.use("/assets/characters", createWorldAssetHandler("characters"));

  const clientDistPath = path.resolve("../client/dist");
  const clientIndexPath = path.join(clientDistPath, "index.html");
  if (fs.existsSync(clientDistPath) && fs.existsSync(clientIndexPath)) {
    app.use("/", express.static(clientDistPath));
    app.get("*", (_req, res) => {
      res.sendFile(clientIndexPath);
    });
  }

  const server = createServer(app);
  setupWebSocket(server, appContext);

  const PORT = process.env.PORT || 3100;
  server.listen(PORT, () => {
    console.log(`[WorldSeed] Server running on http://localhost:${PORT}`);
    console.log(`[WorldSeed] WebSocket available on ws://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("[WorldSeed] Fatal error during startup:", err);
  process.exit(1);
});
