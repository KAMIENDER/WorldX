import { Router } from "express";
import { appContext } from "../../services/app-context.js";
import { generateGraphSnapshot } from "../../content/relationship-graph.js";
import * as eventStore from "../../store/event-store.js";

const router = Router();

// GET /graph/current
router.get("/current", (_req, res) => {
  const data = generateGraphSnapshot(appContext.characterManager);
  data.generatedAt = appContext.worldManager.getCurrentTime();
  res.json(data);
});

// GET /graph/history/:day — find graph snapshot event for a given day
router.get("/history/:day", (req, res) => {
  const day = Number(req.params.day);
  const events = eventStore.queryEvents({
    fromDay: day,
    toDay: day,
    type: "world_state_change",
  });

  const graphEvent = events.find(
    (e) => e.data?.subtype === "relationship_graph",
  );

  if (!graphEvent) {
    res.status(404).json({ error: `No graph snapshot for day ${day}` });
    return;
  }

  res.json(graphEvent.data.graph);
});

export default router;
