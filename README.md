# WorldSeed: One Sentence, One World

Generate a living AI world from a single sentence. WorldSeed creates pixel-art maps, unique characters, and runs autonomous agent simulations — all from one text prompt.

## Architecture

```
User Prompt
    │
    ▼
┌──────────────┐
│  Orchestrator │  ← LLM designs world, characters, scene rules
└──────┬───────┘
       │
  ┌────┴────┐
  ▼         ▼
Map Gen   Character Gen   ← Gemini-powered pixel art pipelines
  │         │
  └────┬────┘
       ▼
┌──────────────┐
│  Simulation  │  ← Agent system: decisions, dialogue, memory, relationships
│   Server     │
└──────┬───────┘
       ▼
┌──────────────┐
│  Game Client │  ← Phaser + React: watch AI characters live their lives
└──────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- API keys (see `.env.example`)

### Setup

```bash
cd world-seed
cp .env.example .env   # Fill in your API keys
npm install
```

### Create a World

```bash
npm run create -- "A Song Dynasty night market with street performers and a mysterious fortune teller"
```

This runs the orchestrator → map generator → character generator pipeline and outputs a complete world to `output/worlds/<world-id>/`.

### Run the Simulation

```bash
npm run dev
```

Opens the game client at `http://localhost:5173` and the API server at `http://localhost:3100`.

The simulation can be controlled from the top bar:
- **Play/Pause** — toggle auto-advancing simulation ticks
- **Step** — advance one tick manually
- **Speed** — control minimum time between ticks
- **Relations** — view the relationship graph
- **Timeline** — browse all simulation events

## Project Structure

```
world-seed/
├── orchestrator/         # LLM-driven world design & config generation
│   ├── src/
│   │   ├── index.mjs           # Main entry: sentence → world
│   │   ├── world-designer.mjs  # LLM interaction for world design
│   │   ├── config-generator.mjs # Bridges generated assets → sim configs
│   │   └── models/ark-client.mjs
│   └── prompts/
│       └── design-world.md     # World design prompt template
├── generators/           # Pixel art generation pipelines
│   ├── map/              # TMJ map generation (Gemini + sharp)
│   └── character/        # Spritesheet generation (Gemini + chromakey)
├── server/               # Simulation engine (Express + SQLite + LLM)
│   └── src/
│       ├── core/         # WorldManager, CharacterManager
│       ├── simulation/   # SimulationEngine, DecisionMaker, DialogueGenerator
│       ├── llm/          # LLMClient, PromptBuilder, output schemas
│       └── store/        # SQLite persistence layer
├── client/               # Game client (Phaser + React)
│   └── src/
│       ├── scenes/       # BootScene, WorldScene
│       ├── ui/           # React overlay (TopBar, SidePanel, Dialogue)
│       └── systems/      # Camera, Pathfinding, Playback
├── output/worlds/        # Generated world outputs
├── scripts/dev.mjs       # Concurrent dev server launcher
└── .env.example          # Required environment variables
```

## Scene-Based Time

WorldSeed uses a scene-configurable time system:

- **Closed scenes** (e.g., "Doomsday Supermarket"): continuous time, characters can't leave
- **Open scenes** (e.g., "Song Dynasty Night Market"): time-limited (e.g., 18:00–02:00), characters come and go

Scene time is configurable per world:
- `startTime`: when the scene begins (e.g., "18:00")
- `tickDurationMinutes`: real-world equivalent per tick (e.g., 15 min)
- `maxTicks`: total ticks before day transition (null = no limit)
- `displayFormat`: "modern", "ancient_chinese", or "fantasy"

## Key Features

- **One-sentence world creation** — describe any scenario and watch it come alive
- **Autonomous AI agents** — characters make decisions, form relationships, have conversations
- **Memory & reflection** — agents remember past events and reflect on their experiences
- **Dynamic pixel art** — maps and characters generated to match your description
- **Multi-day simulation** — watch worlds evolve over multiple days with scene transitions
- **Drama detection** — automatically identifies high-drama moments for content creation

## Environment Variables

See `.env.example` for all required keys. You need:

1. **LLM API** (Volcengine Ark or OpenAI-compatible) — for simulation agent behavior
2. **OpenRouter API** — for Gemini-powered map and character image generation
3. **ARK API** — for the orchestrator's world design LLM

## License

MIT
