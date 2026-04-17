---
name: worldseed-runtime-debugging
description: Runs and debugs the live WorldSeed stack: dev startup, asset serving, Vite proxying, simulation playback, server config loading, and LLM auth failures. Use when `npm run dev` fails, Play does nothing, assets 404, Phaser parses HTML as JSON, or ticks advance without character behavior.
---
# WorldSeed Runtime Debugging

## Startup checklist

Use this sequence first:

```bash
cd world-seed
npm install
cd client && npm install
cd ../server && npm install
cd ..
npm run dev
```

To force a specific generated world at startup:

```bash
cd world-seed
WORLD_DIR=output/worlds/<world-id> npm run dev
```

Expected endpoints:
- Client: `http://localhost:3200`
- Server: `http://localhost:3100`

## Fast triage

### `vite` / `express` / package not found

Cause:
- subproject dependencies are missing

Fix:
- install inside `client/` and `server/`, not just root

### `world.json not found`

Cause:
- runtime is pointed at a generated world, but config loading is reading the wrong directory

Check:
- `output/worlds/<world-id>/config/world.json`
- `server/src/utils/config-loader.ts`

Note:
- runtime world selection now comes from `WORLD_DIR` or the default latest generated world, not `WORLD_ID`
- after startup, the client can switch generated worlds through the `Scene` selector

### Phaser JSON parse error with `<!DOCTYPE`

Cause:
- browser fetched HTML instead of the TMJ or image asset

Check:
- `client/src/scenes/BootScene.ts`
- `client/vite.config.ts`
- `server/src/index.ts`

Current expected asset paths:
- `/assets/map/06-final.tmj`
- `/assets/map/06-background.png`
- `/assets/characters/<char-id>/spritesheet.png`

### Play toggles but nothing happens

Check:
- `client/src/systems/PlaybackController.ts`
- `/api/simulation/tick`

If the button changes state but ticks do not advance, inspect the playback controller and event bus wiring before touching the server.

Note:
- Current UI exposes `Play` / `Pause`, not a top-bar `Step` button
- For single-tick debugging, use the simulation API directly rather than assuming a dedicated UI control exists

### Ticks advance but characters do nothing

This usually means simulation requests are running but decisions, dialogue execution, or downstream action handling are failing.

Check server logs for:
- `Decision wave error`
- `Dialogue session error`
- `LLM API error 401`

Likely causes:
- server did not load root `.env`
- `LLM_API_KEY` is empty or invalid
- `LLM_BASE_URL` / `LLM_DEFAULT_MODEL` mismatch

Relevant files:
- `server/src/index.ts`
- `server/src/llm/llm-client.ts`
- `server/src/simulation/decision-maker.ts`
- `server/src/simulation/simulation-engine.ts`

### Time resets after restart

Check:
- `server/src/core/world-manager.ts`
- `server/src/store/db.ts`
- `server/src/utils/time-helpers.ts`

Current expectation:
- day/tick should persist through `world_global_state`
- scene display time is derived from persisted day/tick plus scene config

## Minimal health checks

Server health:

```bash
curl -s http://localhost:3100/api/health
```

Asset check through Vite:

```bash
curl -I http://localhost:3200/assets/map/06-final.tmj
```

If the TMJ request returns HTML or a redirect, debug proxy/path alignment before touching Phaser code.

## LLM-specific notes

- Server simulation uses `LLM_*` env vars
- Orchestrator uses `ARK_*` env vars
- A generation flow can work while live simulation still fails if only `ARK_*` is configured correctly
- If Ark returns `401`, confirm the server process is reading `world-seed/.env`, not `server/.env`

## UI/runtime ownership

- Preload and asset paths: `client/src/scenes/BootScene.ts`
- Main scene and presentation: `client/src/scenes/WorldScene.ts`
- Camera and playback: `client/src/systems/`
- Top bar / minimap / overlays: `client/src/ui/`
- Asset serving and API mounting: `server/src/index.ts`

## Common current assumptions

- Runtime is single-background-layer oriented
- `ysort` is not part of the current runtime path
- Regions come from the `regions` object layer
- Generated character configs are normalized by `server/src/utils/config-loader.ts`
