// Loads configuration from environment (.env auto-loaded by Bun) with sane defaults.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, ReasoningEffortSetting } from "./types.ts";
import { loadAppState } from "./harness/state.ts";

export const DEFAULT_MODEL = "anthropic/claude-opus-4.8";
/** Low default for deterministic edits; only used when reasoning is off. */
export const DEFAULT_TEMPERATURE = 0;
/** Reasoning on by default — this is a coding agent; quality > a little latency. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffortSetting = "medium";

const REASONING_EFFORTS = new Set<ReasoningEffortSetting>([
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
  "off",
]);

export function loadConfig(): Config {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim() || null;
  const stateFile = process.env.SEPICODE_STATE_FILE?.trim() || join(homedir(), ".sepicode", "state.json");

  // Model precedence: explicit env override > last model persisted via `/model` >
  // the built-in default. This is what makes a `/model` switch survive a restart.
  const envModel = process.env.SEPICODE_MODEL?.trim();
  const model = envModel || loadAppState(stateFile).lastModel || DEFAULT_MODEL;

  return {
    apiKey,
    model,
    maxSteps: intEnv("SEPICODE_MAX_STEPS", 20),
    maxCost: floatEnv("SEPICODE_MAX_COST", 1.0),
    temperature: floatEnv("SEPICODE_TEMPERATURE", DEFAULT_TEMPERATURE),
    reasoningEffort: reasoningEnv("SEPICODE_REASONING_EFFORT", DEFAULT_REASONING_EFFORT),
    theme: process.env.SEPICODE_THEME?.trim() || "catppuccin-mocha",
    sessionDir: process.env.SEPICODE_SESSION_DIR?.trim() || join(homedir(), ".sepicode", "sessions"),
    stateFile,
  };
}

/** Parse + validate a reasoning-effort env var, falling back on anything unknown. */
function reasoningEnv(name: string, fallback: ReasoningEffortSetting): ReasoningEffortSetting {
  const v = process.env[name]?.trim().toLowerCase() as ReasoningEffortSetting | undefined;
  return v && REASONING_EFFORTS.has(v) ? v : fallback;
}

function intEnv(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

function floatEnv(name: string, fallback: number): number {
  const v = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) ? v : fallback;
}
