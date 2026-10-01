// Shared cross-layer contracts. Every layer (agent core, harness, UI) imports from here.
// Keep this file dependency-light: types + the event/runner contract only.

/** Token + cost accounting for a turn (mirrors @openrouter/agent response.usage). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

/**
 * The single event stream from the agent core to the UI.
 * The runner fans the SDK's concurrent streams into this discriminated union.
 */
export type AgentEvent =
  | { type: "turn_start" }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string; args?: unknown }
  | { type: "tool_call_delta"; id: string; argsDelta: string }
  | { type: "tool_call_args"; id: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; result: unknown; isError?: boolean }
  | { type: "usage"; usage: Usage }
  | { type: "turn_end" }
  | { type: "model_changed"; model: string }
  | { type: "notice"; message: string }
  | { type: "session_loaded"; timeline: TimelineItem[]; usage: Usage; model: string }
  | { type: "error"; message: string };

export type AgentEventHandler = (event: AgentEvent) => void;

/** Opaque conversation state passed back into the next turn (from @openrouter/agent). */
export type ConversationState = unknown;

/** Arguments for one agent turn. */
export interface RunOptions {
  input: string;
  state: ConversationState;
  model: string;
}

/** Result of one completed agent turn. */
export interface RunResult {
  state: ConversationState;
  usage: Usage;
  text: string;
}

// ---------------------------------------------------------------------------
// UI view models
// ---------------------------------------------------------------------------

export type Role = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** true while assistant text is still streaming in */
  streaming?: boolean;
  /** system lines only: `error` (red) vs `info` (soft notice, e.g. interrupt). */
  tone?: "error" | "info";
}

export type ToolStatus = "running" | "done" | "error";

export interface ToolCallView {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  status: ToolStatus;
  /** unified diff string when the tool is file_edit, for DiffRenderable */
  diff?: string;
}

/** A timeline entry rendered in the message list: either prose or a tool call. */
export type TimelineItem =
  | ({ kind: "message" } & ChatMessage)
  | ({ kind: "tool" } & ToolCallView);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Reasoning effort, or `off`/`none` to disable reasoning entirely. */
export type ReasoningEffortSetting =
  | "xhigh"
  | "high"
  | "medium"
  | "low"
  | "minimal"
  | "none"
  | "off";

export interface Config {
  apiKey: string | null;
  model: string;
  maxSteps: number;
  maxCost: number;
  /** Sampling temperature. Applied only when reasoning is off (providers like
   *  Anthropic reject a custom temperature while extended thinking is on). */
  temperature: number;
  /** Reasoning effort for the model's thinking phase; `off` disables it. */
  reasoningEffort: ReasoningEffortSetting;
  theme: string;
  /** directory where JSONL session logs live */
  sessionDir: string;
  /** JSON file persisting cross-restart preferences (e.g. last-used model) */
  stateFile: string;
}

// ---------------------------------------------------------------------------
// Command / session-resume contracts (harness ↔ wiring layer)
// ---------------------------------------------------------------------------

/** Everything the UI needs to render a resumed session in one shot. */
export interface SessionLoad {
  timeline: TimelineItem[];
  usage: Usage;
  model: string;
}

/** Result of a `/resume` attempt, returned by the wiring layer to commands. */
export interface ResumeResult {
  ok: boolean;
  /** Human-readable line shown in the transcript. */
  message: string;
  /** Present when `ok`: the rebuilt UI state to swap in. */
  load?: SessionLoad;
}

/** A command's output: a transcript line, plus optional side effects for the UI. */
export interface CommandOutput {
  text: string;
  load?: SessionLoad;
}

// ---------------------------------------------------------------------------
// Session persistence (JSONL — one record per line)
// ---------------------------------------------------------------------------

export type SessionRecord =
  | { ts: number; kind: "user"; content: string }
  | { ts: number; kind: "assistant"; content: string }
  | { ts: number; kind: "tool"; name: string; args: unknown; result: unknown; isError?: boolean }
  | { ts: number; kind: "usage"; usage: Usage }
  | { ts: number; kind: "meta"; model: string };

export interface SessionInfo {
  id: string;
  path: string;
  startedAt: number;
  preview: string;
}
