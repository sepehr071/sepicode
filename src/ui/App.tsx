/** @jsxImportSource @opentui/react */
// Root TUI component for sepicode. Owns ALL UI state and drives the agent through
// the `send(raw, emit)` contract: the wiring layer pushes AgentEvents into the
// `emit` callback we hand it, and we fold those events into React state here.
//
// Why one big reducer-ish state holder: the timeline (interleaved messages + tool
// calls), usage, model, and busy flag all mutate together off the same event
// stream. Keeping them in one component avoids context plumbing for a flat tree,
// and lets MessageList/StatusLine/PromptInput stay pure presentational children.

import { RGBA, SyntaxStyle } from "@opentui/core";
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { mocha, theme } from "../theme.ts";
import type {
  AgentEvent,
  AgentEventHandler,
  Config,
  TimelineItem,
  Usage,
} from "../types.ts";
import { MessageList } from "./MessageList.tsx";
import { PromptInput } from "./PromptInput.tsx";
import { StatusLine } from "./StatusLine.tsx";

export interface AppProps {
  config: Config;
  /**
   * Called when the user submits raw input. The App passes an `emit` it controls;
   * the wiring layer drives AgentEvents through it. Resolves when the turn is done.
   */
  send: (raw: string, emit: AgentEventHandler, signal?: AbortSignal) => Promise<void>;
}

const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cost: 0,
};

/** Monotonic id source for synthetic timeline items (user/system messages). */
let nextLocalId = 0;
const localId = (prefix: string): string => `${prefix}-${nextLocalId++}`;

/**
 * Catppuccin-Mocha syntax theme shared by every Markdown/Diff renderable in the
 * tree. Created once via `SyntaxStyle.fromStyles` — it resolves the native render
 * lib lazily (singleton), so building it during render is safe after the renderer
 * is up, and memoizing avoids reallocating the native style on each keystroke.
 */
function useSyntaxStyle(): SyntaxStyle {
  return useMemo(
    () =>
      SyntaxStyle.fromStyles({
        default: { fg: RGBA.fromHex(mocha.text) },
        keyword: { fg: RGBA.fromHex(mocha.mauve), bold: true },
        string: { fg: RGBA.fromHex(mocha.green) },
        number: { fg: RGBA.fromHex(mocha.peach) },
        comment: { fg: RGBA.fromHex(mocha.overlay1), italic: true },
        function: { fg: RGBA.fromHex(mocha.blue) },
        type: { fg: RGBA.fromHex(mocha.yellow) },
        constant: { fg: RGBA.fromHex(mocha.peach) },
        variable: { fg: RGBA.fromHex(mocha.text) },
        operator: { fg: RGBA.fromHex(mocha.sky) },
        punctuation: { fg: RGBA.fromHex(mocha.overlay2) },
        property: { fg: RGBA.fromHex(mocha.lavender) },
        heading: { fg: RGBA.fromHex(mocha.mauve), bold: true },
        link: { fg: RGBA.fromHex(mocha.blue), underline: true },
        emphasis: { fg: RGBA.fromHex(mocha.text), italic: true },
        strong: { fg: RGBA.fromHex(mocha.text), bold: true },
        // Scope names MarkdownRenderable actually emits.
        "markup.heading": { fg: RGBA.fromHex(mocha.mauve), bold: true },
        "markup.strong": { fg: RGBA.fromHex(mocha.lavender), bold: true },
        "markup.italic": { fg: RGBA.fromHex(mocha.text), italic: true },
        "markup.raw": { fg: RGBA.fromHex(mocha.peach) },
        "markup.list": { fg: RGBA.fromHex(mocha.mauve) },
        "markup.quote": { fg: RGBA.fromHex(mocha.overlay2), italic: true },
        "markup.link": { fg: RGBA.fromHex(mocha.blue), underline: true },
        "markup.strikethrough": { fg: RGBA.fromHex(mocha.overlay1) },
      }),
    [],
  );
}

/**
 * Heuristically pull a unified-diff string out of a tool result so ToolCall can
 * render it with DiffRenderable. The agent's file_edit tool may return the diff
 * under a few shapes; we accept the common ones and otherwise return undefined.
 */
function extractDiff(result: unknown): string | undefined {
  if (typeof result === "string") {
    return looksLikeUnifiedDiff(result) ? result : undefined;
  }
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    const candidate = record.diff ?? record.patch ?? record.unifiedDiff;
    if (typeof candidate === "string" && looksLikeUnifiedDiff(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** A minimal unified-diff sniff: hunk headers or +++/--- file markers present. */
function looksLikeUnifiedDiff(value: string): boolean {
  return /^@@ |\n@@ |^--- |\n--- |^\+\+\+ /.test(value);
}

export function App({ config, send }: AppProps): React.ReactNode {
  const syntaxStyle = useSyntaxStyle();

  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [usage, setUsage] = useState<Usage>(EMPTY_USAGE);
  const [model, setModel] = useState<string>(config.model);
  const [busy, setBusy] = useState(false);

  // Input history for Up/Down recall. `historyIndex === history.length` means
  // "editing a fresh line" (no recall active).
  const [history, setHistory] = useState<string[]>([]);
  const historyIndexRef = useRef(0);

  // The live input buffer lives in OpenTUI's InputRenderable, not React, so typing
  // never re-renders the transcript. We hold a ref to it to read the text on submit
  // and to imperatively clear/seed it (clear-on-submit, history recall) — assigning
  // React state can't reset a buffer the renderable owns. See PromptInput.
  const inputRef = useRef<InputRenderable | null>(null);

  // Per-turn abort handle so Esc can cancel an in-flight turn.
  const abortRef = useRef<AbortController | null>(null);

  // Transcript scrollbox, scrolled imperatively by PageUp/PageDown/Shift+arrows.
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  // Tracks the id of the assistant message currently receiving text_delta chunks,
  // so successive deltas append to the same item instead of spawning new ones.
  const streamingIdRef = useRef<string | null>(null);

  /**
   * Fold a single AgentEvent into UI state. Stable across renders (no deps) so the
   * wiring layer can hold onto one `emit` for the whole turn.
   */
  const emit = useCallback<AgentEventHandler>((event: AgentEvent) => {
    switch (event.type) {
      case "text_delta": {
        // The streaming id MUST be mutated synchronously here, never inside the
        // setTimeline updater. turn_end reads this ref synchronously immediately
        // after, and command turns (/model, /sessions, …) emit text_delta+turn_end
        // in the SAME tick — if the assignment were deferred into the (async)
        // updater, turn_end would read a stale null, skip its reset, and the id
        // would leak into the next turn, merging the next reply into this message.
        const current = streamingIdRef.current;
        if (current === null) {
          // First delta of the turn: open a new streaming assistant message.
          const id = localId("assistant");
          streamingIdRef.current = id;
          setTimeline((prev) => [
            ...prev,
            { kind: "message", id, role: "assistant", content: event.text, streaming: true },
          ]);
        } else {
          // Append to the in-flight streaming message.
          setTimeline((prev) =>
            prev.map((item) =>
              item.kind === "message" && item.id === current
                ? { ...item, content: item.content + event.text }
                : item,
            ),
          );
        }
        break;
      }

      case "tool_call_start": {
        setTimeline((prev) => [
          ...prev,
          {
            kind: "tool",
            id: event.id,
            name: event.name,
            args: event.args,
            status: "running",
          },
        ]);
        break;
      }

      case "tool_call_args": {
        // Full arguments arrive after the tool item was created; patch them in so
        // ToolCall can render the target (e.g. `● Read package.json`).
        setTimeline((prev) =>
          prev.map((item) =>
            item.kind === "tool" && item.id === event.id
              ? { ...item, args: event.args }
              : item,
          ),
        );
        break;
      }

      case "tool_result": {
        setTimeline((prev) =>
          prev.map((item) =>
            item.kind === "tool" && item.id === event.id
              ? {
                  ...item,
                  status: event.isError ? "error" : "done",
                  result: event.result,
                  isError: event.isError,
                  diff: extractDiff(event.result) ?? item.diff,
                }
              : item,
          ),
        );
        break;
      }

      case "usage": {
        setUsage(event.usage);
        break;
      }

      case "turn_end": {
        // Finalize the streaming message so Markdown switches out of streaming mode.
        const streamingId = streamingIdRef.current;
        if (streamingId !== null) {
          setTimeline((prev) =>
            prev.map((item) =>
              item.kind === "message" && item.id === streamingId
                ? { ...item, streaming: false }
                : item,
            ),
          );
          streamingIdRef.current = null;
        }
        setBusy(false);
        break;
      }

      case "model_changed": {
        // A `/model` switch only mutates the wiring layer's model; mirror it into UI
        // state so the status line and frame title reflect the active model.
        setModel(event.model);
        break;
      }

      case "notice": {
        // Soft, non-error system line (e.g. an interrupted turn). turn_end clears busy.
        setTimeline((prev) => [
          ...prev,
          {
            kind: "message",
            id: localId("system"),
            role: "system",
            content: event.message,
            tone: "info",
          },
        ]);
        break;
      }

      case "session_loaded": {
        // /resume: swap in the rebuilt transcript and restore usage/model at once.
        streamingIdRef.current = null;
        setTimeline(event.timeline);
        setUsage(event.usage);
        setModel(event.model);
        break;
      }

      case "error": {
        setTimeline((prev) => [
          ...prev,
          {
            kind: "message",
            id: localId("system"),
            role: "system",
            content: event.message,
            tone: "error",
          },
        ]);
        // An error ends the turn; drop busy so the user can retry.
        streamingIdRef.current = null;
        setBusy(false);
        break;
      }

      case "turn_start": {
        // Defensive turn boundary: guarantee a clean streaming pointer so no prior
        // turn can ever bleed its message id into this one (belt-and-suspenders with
        // the synchronous reset in text_delta/turn_end).
        streamingIdRef.current = null;
        break;
      }

      // reasoning_delta / tool_call_delta are intentionally not surfaced as discrete
      // UI state: arg deltas would only add noise to the chat transcript.
      default:
        break;
    }
  }, []);

  const handleSubmit = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      // Ignore empty submits and submits while a turn is in flight.
      if (trimmed.length === 0 || busy) return;

      setHistory((prev) => {
        const next = [...prev, trimmed];
        historyIndexRef.current = next.length;
        return next;
      });
      // Clear the live buffer imperatively — the renderable owns it, so resetting
      // React state can't empty it (see inputRef note above).
      if (inputRef.current) inputRef.current.value = "";

      setTimeline((prev) => [
        ...prev,
        { kind: "message", id: localId("user"), role: "user", content: trimmed },
      ]);
      setBusy(true);

      // Fresh abort handle for this turn so Esc can cancel it (see useKeyboard).
      const controller = new AbortController();
      abortRef.current = controller;

      // Drive the turn. Surface transport-level rejections as a system error so the
      // UI never hangs in a busy state when the wiring layer throws.
      void send(trimmed, emit, controller.signal).catch((err: unknown) => {
        emit({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    },
    [busy, emit, send],
  );

  // Up/Down recall the previous/next submitted prompt into the input buffer. We
  // write the renderable directly (via ref) for the same reason as clear-on-submit.
  const recall = useCallback(
    (direction: "up" | "down") => {
      if (history.length === 0 || !inputRef.current) return;
      const current = historyIndexRef.current;
      let next: string;
      if (direction === "up") {
        const idx = Math.max(0, current - 1);
        historyIndexRef.current = idx;
        next = history[idx] ?? "";
      } else {
        const idx = Math.min(history.length, current + 1);
        historyIndexRef.current = idx;
        // Stepping past the newest entry clears back to an empty fresh line.
        next = idx === history.length ? "" : (history[idx] ?? "");
      }
      inputRef.current.value = next;
    },
    [history],
  );

  // Global keys: Ctrl+C exits, arrows recall history. Submission is owned by the
  // input's onSubmit so it sees the live buffer rather than a lagging mirror.
  useKeyboard((key) => {
    if (key.name === "c" && key.ctrl) {
      process.exit(0);
    }
    // Esc interrupts an in-flight turn; on an idle line it clears the input.
    if (key.name === "escape") {
      if (busy) {
        abortRef.current?.abort();
      } else if (inputRef.current) {
        inputRef.current.value = "";
      }
      return;
    }
    // Transcript scrolling — available even mid-turn so you can read while it
    // streams. Manual scroll disengages sticky-to-bottom until you scroll back.
    const sb = scrollRef.current;
    if (sb) {
      if (key.name === "pageup") return void sb.scrollBy(-1, "viewport");
      if (key.name === "pagedown") return void sb.scrollBy(1, "viewport");
      if (key.shift && key.name === "up") return void sb.scrollBy(-3, "absolute");
      if (key.shift && key.name === "down") return void sb.scrollBy(3, "absolute");
    }
    // History recall only while idle — editing mid-turn would just be discarded.
    if (busy) return;
    if (key.name === "up") {
      recall("up");
    } else if (key.name === "down") {
      recall("down");
    }
  });

  return (
    <box
      style={{
        flexGrow: 1,
        flexDirection: "column",
        backgroundColor: theme.bg,
      }}
    >
      <MessageList
        timeline={timeline}
        syntaxStyle={syntaxStyle}
        model={model}
        scrollRef={scrollRef}
      />
      <StatusLine model={model} usage={usage} busy={busy} />
      <PromptInput inputRef={inputRef} busy={busy} onSubmit={handleSubmit} />
    </box>
  );
}
