import { EventEmitter } from "node:events";
import { WorldManager } from "../core/world-manager.js";
import { CharacterManager } from "../core/character-manager.js";
import { LLMClient } from "../llm/llm-client.js";
import { PromptBuilder } from "../llm/prompt-builder.js";
import { SimulationEngine } from "../simulation/simulation-engine.js";
import { DecisionMaker } from "../simulation/decision-maker.js";
import { DialogueGenerator } from "../simulation/dialogue-generator.js";
import { initDatabase } from "../store/db.js";
import { getDb } from "../store/db.js";
import * as snapshotStore from "../store/snapshot-store.js";
import { reloadConfigs } from "../utils/config-loader.js";

export class AppContext {
  worldManager!: WorldManager;
  characterManager!: CharacterManager;
  llmClient!: LLMClient;
  promptBuilder!: PromptBuilder;
  decisionMaker!: DecisionMaker;
  dialogueGenerator!: DialogueGenerator;
  simulationEngine!: SimulationEngine;

  eventBus = new EventEmitter();

  private worldDirPath?: string;

  async initialize(worldDirPath?: string): Promise<void> {
    this.worldDirPath = worldDirPath;
    initDatabase();
    this.rebuildRuntime();
  }

  getWorldDir(): string | undefined {
    return this.worldDirPath;
  }

  resetWorldState(): void {
    this.clearPersistedState();
    reloadConfigs();
    this.rebuildRuntime();
    this.eventBus.emit("simulation_status", { status: "idle" });
  }

  switchWorld(worldDirPath: string): void {
    this.worldDirPath = worldDirPath;
    this.clearPersistedState();
    reloadConfigs();
    this.rebuildRuntime();
    this.eventBus.emit("simulation_status", { status: "idle" });
  }

  private clearPersistedState(): void {
    for (const snapshot of snapshotStore.listSnapshots()) {
      snapshotStore.deleteSnapshot(snapshot.id);
    }

    getDb().exec(`
      DELETE FROM events;
      DELETE FROM memories;
      DELETE FROM relationships;
      DELETE FROM character_states;
      DELETE FROM world_object_states;
      DELETE FROM world_global_state;
      DELETE FROM diary_entries;
      DELETE FROM snapshots;
      DELETE FROM llm_call_logs;
      DELETE FROM content_candidates;
    `);
  }

  private rebuildRuntime(): void {
    this.worldManager = new WorldManager();
    this.worldManager.initialize(this.worldDirPath);

    this.characterManager = new CharacterManager(this.worldManager);
    this.characterManager.initialize();

    if (!this.llmClient) {
      this.llmClient = new LLMClient();
    }

    this.characterManager.memoryManager.setLLMClient(this.llmClient);

    if (!this.promptBuilder) {
      this.promptBuilder = new PromptBuilder();
      this.promptBuilder.initialize();
    }

    this.decisionMaker = new DecisionMaker(
      this.llmClient,
      this.promptBuilder,
      this.characterManager,
      this.worldManager,
    );

    this.dialogueGenerator = new DialogueGenerator(
      this.llmClient,
      this.promptBuilder,
      this.characterManager,
      this.worldManager,
    );

    this.simulationEngine = new SimulationEngine(
      this.worldManager,
      this.characterManager,
      this.llmClient,
      this.promptBuilder,
    );
  }
}

export const appContext = new AppContext();
