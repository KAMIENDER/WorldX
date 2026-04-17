---
name: worldseed-simulation-behavior
description: Changes WorldSeed simulation semantics: scene time, multi-day transitions, worldActions, logical locations, main-area movement, client wandering, and dialogue approach animation. Use when editing character behavior, movement rules, tick logic, location modeling, or server/client simulation boundaries.
---
# WorldSeed Simulation Behavior

## Core model

Keep these boundaries intact unless the task explicitly changes the architecture:

- Server owns logical state:
  - current day and tick
  - logical location
  - action decisions
  - dialogue, memories, relationships, effects

- Client owns local presentation:
  - random ambient wandering near an anchor
  - pathfinding to a chosen point
  - dialogue approach animation
  - camera and scene presentation

Do not add persistent server-side `x/y` state unless the task clearly requires an architectural change.

## Location model

Current rules:

- Authored map regions come from the `regions` object layer
- Region-less worlds still work through synthetic `main_area` fallback
- Large `main_area` spaces may also use generated `mainAreaPoints` for meaningful long-distance movement
- Server reasons about domains and locations, not exact map coordinates
- Client converts logical locations and main-area points into walkable target points

Key files:
- `server/src/core/world-manager.ts`
- `server/src/simulation/action-menu-builder.ts`
- `server/src/simulation/action-executor.ts`
- `client/src/systems/MapManager.ts`
- `client/src/systems/CharacterMovement.ts`

## Movement model

Current intent:

- Long-distance movement is an AI/server decision
- Arrival target inside a region should be a randomized near-center walkable point, not a fixed point
- Long-distance movement inside `main_area` should stay point-to-point at the logical level; local drift after arrival is presentation only
- Once arrived, client wandering stays near `movementAnchor`
- Pinned regions bias wandering inward so characters do not leak outside bounds
- Dialogue approach spacing on the client should scale from current character display size, not fixed absolute pixels

If changing movement, preserve this split:
- "Go somewhere meaningful" -> server
- "Micro-move while idle" -> client

Relevant files:
- `client/src/systems/CharacterMovement.ts`
- `client/src/objects/CharacterSprite.ts`
- `client/src/systems/MapManager.ts`
- `client/src/scenes/WorldScene.ts`

## Dialogue model

Current intent:

- Server decides dialogue based on logical state and tick flow
- For `main_area`, server-side dialogue gating should respect world-size-based proximity thresholds rather than arbitrary screen pixels
- Client adds approach animation for visual believability
- The approach step is presentation, not authoritative world state

Relevant files:
- `server/src/simulation/simulation-engine.ts`
- `server/src/simulation/decision-maker.ts`
- `client/src/scenes/WorldScene.ts`
- `client/src/systems/CharacterMovement.ts`

## Time model

WorldSeed uses scene-configurable time, not fixed town-day assumptions.

Check these files when changing time semantics:
- `server/src/utils/time-helpers.ts`
- `server/src/types/world.ts`
- `server/src/api/routes/world.ts`
- `server/src/api/routes/simulation.ts`

Keep these principles:
- scene start time is configurable
- tick duration is configurable
- `maxTicks` can be finite or open-ended
- multi-day transitions are config-driven
- day/tick should persist across server restarts
- no sleep/home assumptions should leak back in without explicit product changes

## Decision model

Current simulation is reactive.

Keep these principles:
- do not reintroduce initial daily-plan generation unless the product explicitly changes
- do not assume a separate revise-plan loop exists
- memory retrieval should stay lightweight and not depend on embedding/vector infrastructure unless the task explicitly restores that architecture

## World actions

`worldActions` are true world-level actions, not tied to a specific region.

When changing them, verify all layers:
- design prompt and normalization
- config generation
- server action menu
- action execution and event wording
- client rendering if new event types appear

Key files:
- `orchestrator/prompts/design-world.md`
- `orchestrator/src/world-design-utils.mjs`
- `orchestrator/src/config-generator.mjs`
- `server/src/core/world-manager.ts`
- `server/src/simulation/action-menu-builder.ts`
- `server/src/simulation/action-executor.ts`

## Verification

After simulation-behavior changes:

1. Test a world with authored regions.
2. Test a world without authored regions.
3. Test a world whose activity mostly happens in `main_area`.
4. Verify dialogue still starts and characters visually approach each other.
5. Verify idle wandering stays believable and bounded.
6. Verify tick progression still works through `Play` / `Pause` and direct tick execution paths.

## Common mistakes

- Mixing logical location changes with client-only micro-movement
- Reintroducing old `location` layer or `ysort` assumptions
- Making dialogue depend on exact coordinates instead of logical state
- Breaking region-less worlds by assuming every map has authored regions
- Renaming action/location fields without updating config generation and runtime consumers
