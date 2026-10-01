// Context-window management. Long sessions eventually exceed the model's context
// limit; before that happens we ask a cheap model to summarize the conversation
// so the caller can replace bulk history with the summary on the next turn.
//
// Everything here is best-effort: compaction is an optimization, never a
// correctness requirement, so any failure degrades to "didn't compact" rather
// than propagating.

import { callModel } from "@openrouter/agent";
import type { ConversationState, Usage } from "../types.ts";

/** Default context budget (tokens). Matches the assumed 200k-class window. */
const DEFAULT_CONTEXT_LIMIT = 200_000;

/** Compact once usage crosses this fraction of the context limit. */
const COMPACT_THRESHOLD = 0.75;

/** Small, fast model used for the summary itself — never the main model. */
const SUMMARIZER_MODEL = "anthropic/claude-haiku-4.5";

/**
 * Rough token estimate. The ~4-chars-per-token heuristic is intentionally crude:
 * it's only used to size text we feed the summarizer, where being within a
 * factor of two is fine. Real accounting comes from the SDK's `Usage`.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface MaybeCompactOptions {
  /** OpenRouter client (typed loosely to avoid coupling harness to the SDK). */
  client: unknown;
  /** Main conversation model (used to derive defaults, not for the summary). */
  model: string;
  usage: Usage;
  state: ConversationState;
  contextLimit?: number;
}

export interface CompactResult {
  compacted: boolean;
  summary?: string;
}

/**
 * If the running token total has crossed the compaction threshold, summarize the
 * conversation so far and hand the summary back. The caller decides how to inject
 * it (typically: start a fresh turn seeded with the summary). Under threshold —
 * or on any error — returns `{ compacted: false }`.
 */
export async function maybeCompact(
  opts: MaybeCompactOptions,
): Promise<CompactResult> {
  const limit = opts.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  if (opts.usage.totalTokens < limit * COMPACT_THRESHOLD) {
    return { compacted: false };
  }

  const transcript = stringifyState(opts.state);
  if (!transcript) return { compacted: false };

  try {
    // One-shot, tool-less call on the cheap model. getText() drains the response
    // and returns just the summary text.
    const result = callModel(opts.client as never, {
      model: SUMMARIZER_MODEL,
      input: buildSummaryPrompt(transcript),
    });
    const summary = (await result.getText()).trim();
    if (!summary) return { compacted: false };

    return { compacted: true, summary };
  } catch {
    // Best-effort: an unavailable summarizer must not break the main loop.
    return { compacted: false };
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Flatten the opaque conversation state into text for the summarizer. The state
 * shape is owned by the SDK, so we serialize defensively: JSON when possible,
 * and we clamp the size so we never blow the summarizer's own context. The tail
 * is kept (most recent turns matter most for a running summary).
 */
function stringifyState(state: ConversationState): string {
  if (state == null) return "";

  let text: string;
  try {
    text = typeof state === "string" ? state : JSON.stringify(state);
  } catch {
    return "";
  }
  if (!text) return "";

  // Cap the input to ~24k tokens of source material so the summarization call
  // stays cheap and within the small model's window; prefer the recent tail.
  const maxChars = 24_000 * 4;
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

function buildSummaryPrompt(transcript: string): string {
  return [
    "Summarize the following coding-assistant conversation so it can replace the",
    "full history while preserving everything needed to continue the work.",
    "Capture: the user's goal, key decisions, files touched, current state, and",
    "any open TODOs. Be concise and factual. Output only the summary.",
    "",
    "--- CONVERSATION ---",
    transcript,
  ].join("\n");
}
