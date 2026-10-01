/** @jsxImportSource @opentui/react */
// The pinned composer at the bottom of the screen: a bordered single-line input
// with a `›` prompt glyph and a dim affordance hint. The border switches to the
// focus color while editing so it reads as the active surface.
//
// Buffer ownership: the InputRenderable owns the live keystroke buffer; we do NOT
// mirror it into React (that would re-render the transcript on every keystroke).
// App holds a ref to the renderable so it can read the text on submit and clear or
// seed it imperatively (clear-on-submit, Up/Down history recall). This is the
// idiomatic OpenTUI pattern: a `value=""` prop can't clear a buffer the renderable
// owns once the prop already equals "", so we assign `ref.current.value` directly.

import type { InputRenderable } from "@opentui/core";
import { theme } from "../theme.ts";

export interface PromptInputProps {
  /** Ref to the underlying InputRenderable, owned by App (read/clear/seed). */
  inputRef: React.RefObject<InputRenderable | null>;
  /** While a turn runs the input is dimmed and submissions are a no-op. */
  busy: boolean;
  /** Fired on Enter with the current buffer. */
  onSubmit: (raw: string) => void;
}

export function PromptInput({ inputRef, busy, onSubmit }: PromptInputProps): React.ReactNode {
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <box
        style={{
          flexDirection: "row",
          height: 3,
          border: true,
          borderColor: busy ? theme.border : theme.borderFocus,
          backgroundColor: theme.bgInput,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <text fg={busy ? theme.dim : theme.accent}>{"› "}</text>
        <input
          ref={inputRef}
          focused={!busy}
          placeholder={busy ? "Working…" : "Send a message"}
          // The input's onSubmit is typed as the union of `(value: string)` and
          // `(event: SubmitEvent)`; at runtime InputRenderable always fires the
          // value string, so we narrow and fall back to the live buffer otherwise.
          onSubmit={(submitted) =>
            onSubmit(typeof submitted === "string" ? submitted : (inputRef.current?.value ?? ""))
          }
          style={{
            flexGrow: 1,
            backgroundColor: theme.bgInput,
            textColor: theme.fg,
            focusedBackgroundColor: theme.bgInput,
            focusedTextColor: theme.fg,
            placeholderColor: theme.dim,
            cursorColor: theme.accent,
          }}
        />
      </box>

      {/* Affordance hint — the input mini-language, kept subtle so it recedes. */}
      <box style={{ flexDirection: "row", paddingLeft: 1 }}>
        <text fg={theme.dim}>@file</text>
        <text fg={theme.muted}>{"  attach   "}</text>
        <text fg={theme.dim}>!shell</text>
        <text fg={theme.muted}>{"  run   "}</text>
        <text fg={theme.dim}>/help</text>
        <text fg={theme.muted}>{"  commands"}</text>
      </box>
    </box>
  );
}
