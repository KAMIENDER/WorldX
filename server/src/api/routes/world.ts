import path from "node:path";
import { Router } from "express";
import { appContext } from "../../services/app-context.js";
import { buildSceneRuntimeInfo, buildWorldTimeInfo } from "../../utils/time-helpers.js";
import * as worldStateStore from "../../store/world-state-store.js";
import { listGeneratedWorlds } from "../../utils/world-directories.js";

const router = Router();

router.get("/time", (_req, res) => {
  res.json(buildWorldTimeInfo(appContext.worldManager.getCurrentTime()));
});

router.get("/info", (_req, res) => {
  const wm = appContext.worldManager;
  const currentWorldDir = appContext.getWorldDir();
  res.json({
    worldName: wm.getWorldName(),
    worldDescription: wm.getWorldDescription(),
    currentWorldId: currentWorldDir ? path.basename(currentWorldDir) : null,
    sceneConfig: wm.getSceneConfig(),
    sceneRuntime: buildSceneRuntimeInfo(wm.getSceneConfig()),
    worldActions: wm.getWorldActions(),
    mainAreaPoints: wm.getMainAreaPoints(),
    worldSize: wm.getWorldSize(),
    mainAreaDialogueRadiusPx: wm.getMainAreaDialogueDistanceThreshold(),
  });
});

router.get("/worlds", (_req, res) => {
  const currentWorldDir = appContext.getWorldDir();
  const currentWorldId = currentWorldDir ? path.basename(currentWorldDir) : null;

  res.json({
    currentWorldId,
    worlds: listGeneratedWorlds().map((world) => ({
      id: world.id,
      worldName: world.worldName,
      isCurrent: world.id === currentWorldId,
    })),
  });
});

router.post("/select", (req, res) => {
  const worldId = typeof req.body?.worldId === "string" ? req.body.worldId : "";
  if (!worldId) {
    res.status(400).json({ error: "worldId is required" });
    return;
  }

  const world = listGeneratedWorlds().find((entry) => entry.id === worldId);
  if (!world) {
    res.status(404).json({ error: "World not found" });
    return;
  }

  appContext.switchWorld(world.dir);
  res.json({
    ok: true,
    currentWorldId: world.id,
    worldName: world.worldName,
  });
});

router.get("/locations", (_req, res) => {
  res.json(appContext.worldManager.getAllLocations());
});

router.get("/locations/:id/state", (req, res) => {
  const loc = appContext.worldManager.getLocation(req.params.id);
  if (!loc) {
    res.status(404).json({ error: "Location not found" });
    return;
  }

  const objects = appContext.worldManager.getLocationObjects(loc.id);
  const chars = appContext.characterManager.getCharactersAtLocation(loc.id);

  res.json({
    location: loc,
    objects: objects.map((o) => ({
      objectId: o.objectId,
      state: o.state,
      stateDescription: o.stateDescription,
      currentUsers: o.currentUsers,
    })),
    characters: chars.map((c) => ({
      id: c.profile.id,
      name: c.profile.name,
      action: c.state.currentAction,
    })),
  });
});

router.get("/global-state", (_req, res) => {
  res.json(worldStateStore.getAllGlobalState());
});

export default router;
