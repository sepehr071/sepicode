// Translation helpers: turn the SDK's `getFullResponsesStream()` events into the
// `AgentEvent` union from `../types.ts`. Kept separate from runner.ts so the
// mapping logic (event-shape knowledge of @openrouter/agent) lives in one place.
//
// Design note — why a single stream instead of N concurrent iterators:
// `getFullResponsesStream()` already interleaves text deltas, reasoning deltas,
// function-call argument deltas, tool results, and turn delimiters in arrival
// order. Driving everything off one stream preserves that ordering and avoids
// races between separate getTextStream()/getToolStream() consumers.
//
// Design note — per-item text tracking:
// `response.output_text.delta` / `response.reasoning_text.delta` events already
// carry a *pure delta* (`delta: string`) tagged with `itemId`. We forward those
// deltas verbatim, so a multi-step run that emits several OutputMessage items is
// handled correctly without any global text cursor — the SDK splits per item for
// us. The `callIdByItem` map below is the only state we keep, and only to bridge
// argument-delta events (keyed by `itemId`) back to their tool `callId`.

import type {
  ResponseStreamEvent,
  isToolResultEvent as IsToolResultEvent,
} from "@openrouter/agent";
import {
  isToolResultEvent,
  isTurnEndEvent,
  isTurnStartEvent,
} from "@openrouter/agent";
import type { AgentEvent, Usage } from "../types.ts";

// Re-export the guard reference so runner.ts imports its event vocabulary from
// one module. (Type-only alias keeps the named import above tree-shakeable.)
export type _GuardRef = typeof IsToolResultEvent;

/** The SDK's `Usage` carries a nullable `cost`; normalize to our non-null contract. */
export function toUsage(usage: {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cost?: number | null;
} | null | undefined): Usage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    // OpenRouter reports cost as nullable; the UI contract needs a number.
    cost: usage?.cost ?? 0,
  };
}

/**
 * A tool result is an error when the SDK wrapped it in its `{ error: string }`
 * envelope (see ModelResult.broadcastToolResult) — rejected executions, parse
 * failures, and tools that threw all flow through that shape. Any other payload
 * is a successful result.
 */
export function isErrorResult(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    typeof (result as { error: unknown }).error === "string"
  );
}

/**
 * Stateful mapper for one `runAgent` invocation. Holds the `itemId -> callId`
 * bridge needed because function-call *argument delta* events identify the call
 * by streaming `itemId`, while `tool_call_start`/`tool_result` use the tool
 * `callId`. One instance per run; never shared across turns.
 */
export class StreamMapper {
  // Maps the streaming output-item id of a function_call to its tool callId,
  // and remembers the tool name so tool.result events (which omit the name) can
  // be labelled.
  private readonly callIdByItem = new Map<string, string>();
  private readonly nameByCallId = new Map<string, string>();

  /**
   * Map one raw SDK stream event to zero or one `AgentEvent`. Returns null for
   * events we deliberately ignore (turn delimiters, lifecycle, server-tool noise)
   * so the caller can skip cheaply. Turn start/end are surfaced by the runner
   * itself around the whole call, not per SDK turn, so they are ignored here.
   */
  map(event: ResponseStreamEvent): AgentEvent | null {
    // Turn delimiters are internal multi-step markers; the runner emits a single
    // logical turn_start/turn_end around the entire run instead.
    if (isTurnStartEvent(event) || isTurnEndEvent(event)) return null;

    if (isToolResultEvent(event)) {
      const callId = event.toolCallId;
      return {
        type: "tool_result",
        id: callId,
        name: this.nameByCallId.get(callId) ?? "",
        result: event.result,
        isError: isErrorResult(event.result),
      };
    }

    // Remaining events are the SDK's passthrough StreamEvents (discriminated by
    // `type`). Narrow on the string discriminator.
    if (!("type" in event) || typeof event.type !== "string") return null;

    switch (event.type) {
      case "response.output_text.delta":
        return { type: "text_delta", text: event.delta };

      case "response.reasoning_text.delta":
        return { type: "reasoning_delta", text: event.delta };

      case "response.output_item.added": {
        // A new function_call item begins here — emit tool_call_start with its
        // initial (possibly empty) argument string and register the id bridges.
        const item = event.item;
        if (item && item.type === "function_call") {
          const callId = item.callId;
          this.callIdByItem.set(item.id ?? "", callId);
          this.nameByCallId.set(callId, item.name);
          return {
            type: "tool_call_start",
            id: callId,
            name: item.name,
            args: item.arguments ? safeJson(item.arguments) : undefined,
          };
        }
        return null;
      }

      case "response.function_call_arguments.delta": {
        const callId = this.callIdByItem.get(event.itemId) ?? event.itemId;
        return { type: "tool_call_delta", id: callId, argsDelta: event.delta };
      }

      case "response.output_item.done": {
        // Args stream in *after* output_item.added (which carries an empty
        // argument string), so the complete, parsed arguments are only available
        // here. Emit a tool_call_args update so the UI can label the tool line
        // with its target (path / pattern / command) instead of just the name.
        const item = event.item;
        if (item && item.type === "function_call") {
          return {
            type: "tool_call_args",
            id: item.callId,
            args: item.arguments ? safeJson(item.arguments) : {},
          };
        }
        return null;
      }

      case "error":
        return { type: "error", message: event.message };

      default:
        return null;
    }
  }
}

/** Parse a JSON argument string, falling back to the raw string when malformed. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
