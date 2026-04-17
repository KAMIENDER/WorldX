---
name: worldseed-generation-pipeline
description: Changes or debugs the one-sentence world generation pipeline: orchestrator prompts, world design normalization, style-aware map generation, character generation, output naming, and config bridging. Use when working on `npm run create`, generated world contents, worldActions/regions, scene time config, or asset/config contracts.
---
# WorldSeed Generation Pipeline

## Use this skill when

Apply this skill for tasks involving:
- `npm run create`
- orchestrator prompt/schema changes
- map or character generation behavior
- generated world output layout
- config generation from assets
- asset filename or path contract changes

## Pipeline order

The create flow is:

1. `orchestrator/src/world-designer.mjs`
2. `generators/map/src/index.mjs`
3. `generators/character/src/index.mjs`
4. `orchestrator/src/config-generator.mjs`

Current orchestrator behavior:
- map and character generation are launched in parallel
- config generation waits for both to finish
- keep child process orchestration async; do not reintroduce blocking `execSync`

## Edit map

Touch these areas for map work:
- Prompt/schema inputs: `orchestrator/prompts/design-world.md`
- Normalization/defaults: `orchestrator/src/world-design-utils.mjs`
- Map pipeline: `generators/map/src/`
- Map prompts: `generators/map/prompts/`

Current map-generation assumptions:
- map visual style is driven by the user's request via `mapDescription`; do not assume the pipeline is fixed to pixel art
- keep near-top-down readability and stable region/walkable extraction even when loosening style constraints
- if Step 3 region review exhausts retries, the pipeline may drop final failing regions instead of forcing bad boxes through

Current runtime-facing map contract:
- `map/06-final.tmj`
- `map/06-background.png`
- `map/06-regions-scaled.json`
- region layer name is `regions`

If you rename map outputs, update both:
- `client/src/scenes/BootScene.ts`
- `server/src/index.ts`

## Edit character generation

Touch these areas for character asset work:
- Prompting: `generators/character/prompts/`
- Generation pipeline: `generators/character/src/index.mjs`
- Runtime display: `client/src/config/game-config.ts`, `client/src/objects/CharacterSprite.ts`

Current runtime-facing character contract:
- `characters/characters.json`
- `characters/<char-id>/spritesheet.png`
- `config/characters/<char-id>.json`

If you change character manifest or output layout, update:
- `orchestrator/src/config-generator.mjs`
- `server/src/utils/config-loader.ts`
- `client/src/scenes/BootScene.ts`

## Edit config bridging

Use `orchestrator/src/config-generator.mjs` when the problem is:
- generated regions not matching runtime locations
- start positions or character config shape
- worldActions not appearing in runtime
- `mainAreaPoints` / `worldSize` / scene metadata drifting from generated map output
- no-region worlds needing `main_area` fallback

Use `server/src/utils/config-loader.ts` when the problem is:
- runtime reading the wrong generated files
- generated character config shape not matching server expectations
- scene config merging between `config/scene.json` and `config/world.json` is wrong

## Verification

After generation-pipeline changes:

1. Run:

```bash
cd world-seed
npm run create -- "<prompt>"
```

2. Inspect the new `output/worlds/<world-id>/` directory.
3. Confirm expected files exist before touching runtime debugging.
4. If runtime uses the generated world, start with:

```bash
WORLD_DIR=output/worlds/<world-id> npm run dev
```

Or start with plain `npm run dev` and switch worlds from the client `Scene` selector if the desired world is not already the latest output.

## Common pitfalls

- Map filenames in runtime are fixed by the current BootScene contract.
- Character generation may succeed while config generation still fails if `config-generator.mjs` assumptions drift.
- The runtime consumes `config/world.json` and `config/characters/*.json`, not raw `world-design.json`.
- A world can generate successfully while still being un-runnable if output naming and runtime asset paths drift apart.
