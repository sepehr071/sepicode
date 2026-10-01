// Agent core: constructs the OpenRouter client and drives one agent turn,
// fanning the SDK's streaming response into the `AgentEvent` union consumed by
// the harness/UI.
//
// One `runAgent` call == one logical turn from the caller's perspective, even
// though the SDK may internally take several steps (tool loops). We emit exactly
// one `turn_start` at the beginning and one `turn_end` after the final response,
// with all text/reasoning/tool events in between.

import {
  callModel,
  maxCost as maxCostCondition,
  OpenRouter,
  stepCountIs,
  type ConversationState as SdkConversationState,
  type ResponseStreamEvent,
  type StateAccessor,
} from "@openrouter/agent";
import { allTools } from "../tools/index.ts";
import type {
  AgentEventHandler,
  ConversationState,
  ReasoningEffortSetting,
  RunResult,
} from "../types.ts";
import { StreamMapper, toUsage } from "./events.ts";

/** Build the OpenRouter client used for all model calls. */
export function createClient(apiKey: string): OpenRouter {
  return new OpenRouter({ apiKey });
}

/** Options for a single agent turn. */
export interface RunAgentOptions {
  input: string;
  state: ConversationState;
  model: string;
  maxSteps: number;
  maxCost: number;
  /** System prompt (SDK `instructions`) — identity, environment, behavior. */
  instructions: string;
  /** Sampling temperature; applied only when reasoning is off (see below). */
  temperature: number;
  /** Reasoning effort; `off`/`none` disables the thinking phase. */
  reasoningEffort: ReasoningEffortSetting;
  /** Aborts the in-flight turn when the user interrupts (Esc). */
  signal?: AbortSignal;
}

/**
 * Run one agent turn. Sends `input` (with prior `state` for multi-turn context),
 * lets the SDK auto-execute tools, streams every event into `onEvent`, and
 * returns the final state/usage/text so the caller can persist and continue.
 *
 * Never throws: any failure is surfaced as an `{type:'error'}` event and the
 * call returns a best-effort `RunResult` (prior state, zeroed usage) so the host
 * process stays alive.
 */
export async function runAgent(
  client: OpenRouter,
  opts: RunAgentOptions,
  onEvent: AgentEventHandler,
): Promise<RunResult> {
  // callModel persists conversation state through a StateAccessor (load/save),
  // not a raw state object. We bridge the caller's opaque ConversationState into
  // an in-memory accessor: load() hands the SDK the prior state (null on a fresh
  // conversation, which makes the SDK create initial state itself), and save()
  // captures the latest snapshot. getState() returns the final state below.
  type Tools = typeof allTools;
  const prior = (opts.state ?? null) as SdkConversationState<Tools> | null;
  const accessor: StateAccessor<Tools> = {
    load: async () => prior,
    save: async () => {
      // No external persistence here; the harness owns durable storage. We read
      // the final state via getState() once the run completes.
    },
  };

  onEvent({ type: "turn_start" });

  // Reasoning and a custom temperature are mutually exclusive in practice: with
  // extended thinking on, providers like Anthropic reject any temperature but 1.
  // So when reasoning is enabled we send `reasoning` and omit `temperature`;
  // otherwise we send the configured `temperature` and no reasoning.
  const reasoningOn = opts.reasoningEffort !== "off" && opts.reasoningEffort !== "none";
  // `off` is our own sentinel (the SDK has no "off"); narrow it away when enabled.
  const sampling = reasoningOn
    ? { reasoning: { effort: opts.reasoningEffort as Exclude<ReasoningEffortSetting, "off" | "none"> } }
    : { temperature: opts.temperature };

  const result = callModel(client, {
    model: opts.model,
    input: opts.input,
    instructions: opts.instructions,
    tools: allTools,
    state: accessor,
    ...sampling,
    // Bound the inner tool loop on both step count and spend. The SDK default of
    // stepCountIs(5) is too low for real coding sessions.
    stopWhen: [stepCountIs(opts.maxSteps), maxCostCondition(opts.maxCost)],
  }, { signal: opts.signal });

  const mapper = new StreamMapper();

  try {
    // `callModel` is lazy — it performs no work until a stream or getResponse()
    // is consumed. Draining getFullResponsesStream() drives the entire run
    // (including tool execution) to completion.
    for await (const event of result.getFullResponsesStream() as AsyncIterable<ResponseStreamEvent>) {
      const mapped = mapper.map(event);
      if (mapped) onEvent(mapped);
    }

    // getResponse() resolves after the stream is fully consumed; it carries the
    // final usage. getState() returns the conversation state for the next turn.
    const response = await result.getResponse();
    const nextState = await result.getState();
    const usage = toUsage(response.usage);

    onEvent({ type: "usage", usage });
    onEvent({ type: "turn_end" });

    return {
      state: nextState,
      usage,
      text: response.outputText ?? "",
    };
  } catch (err) {
    // A user interrupt (Esc → AbortController.abort) surfaces here as an abort.
    // Show it as a soft notice rather than a red error, and keep the *prior* state
    // so the next turn resumes from before the cancelled one.
    const aborted = opts.signal?.aborted === true;
    onEvent(
      aborted
        ? { type: "notice", message: "Interrupted." }
        : { type: "error", message: err instanceof Error ? err.message : String(err) },
    );
    onEvent({ type: "turn_end" });

    // Best-effort return so the host loop survives: keep the prior state and
    // report zeroed usage. The notice/error event already informed the UI.
    return {
      state: opts.state,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
      text: "",
    };
  }
}
