/** @jsxImportSource @opentui/react */
// Renders a single transcript message. Three shapes:
//   user      — a left bar marker + the raw text, in the user accent color
//   assistant — Markdown (streaming mode while chunks arrive, finalized after)
//   system    — an error/notice line, dimmed and colored by severity
//
// Why Markdown only for the assistant: model output is the only content authored
// in Markdown. User and system lines are literal strings and rendering them as
// Markdown would mangle stray `*`/`#`/`_` the user typed.

import { TextAttributes } from "@opentui/core";
import type { SyntaxStyle } from "@opentui/core";
import { theme } from "../theme.ts";
import type { ChatMessage } from "../types.ts";

export interface MessageProps {
  message: ChatMessage;
  syntaxStyle: SyntaxStyle;
}

export function Message({ message, syntaxStyle }: MessageProps): React.ReactNode {
  if (message.role === "user") {
    return <UserMessage content={message.content} />;
  }
  if (message.role === "system") {
    return <SystemMessage content={message.content} tone={message.tone ?? "error"} />;
  }
  return (
    <AssistantMessage
      content={message.content}
      streaming={message.streaming === true}
      syntaxStyle={syntaxStyle}
    />
  );
}

/** User turn: a vertical bar gutter (`▌`) in the user color, then the prompt. */
function UserMessage({ content }: { content: string }): React.ReactNode {
  return (
    <box style={{ flexDirection: "row", marginTop: 1, marginBottom: 1, backgroundColor: theme.bgPanel }}>
      <text fg={theme.user}>▌ </text>
      <box style={{ flexGrow: 1 }}>
        <text fg={theme.user} attributes={TextAttributes.BOLD}>
          {content}
        </text>
      </box>
    </box>
  );
}

/**
 * Assistant turn: full Markdown. `streaming` is forwarded to the renderable so the
 * trailing block stays unstable while deltas land, then snaps to a finalized parse
 * once the turn ends (per MarkdownRenderable's streaming contract).
 */
function AssistantMessage({
  content,
  streaming,
  syntaxStyle,
}: {
  content: string;
  streaming: boolean;
  syntaxStyle: SyntaxStyle;
}): React.ReactNode {
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <markdown
        content={content}
        syntaxStyle={syntaxStyle}
        streaming={streaming}
        fg={theme.assistant}
      />
    </box>
  );
}

/**
 * System notice. `error` tone is a red `●` (provider/tool failures); `info` tone
 * is a soft peach `⊘` (user-initiated, e.g. an interrupted turn) so a deliberate
 * cancel doesn't read as something breaking.
 */
function SystemMessage({
  content,
  tone,
}: {
  content: string;
  tone: "error" | "info";
}): React.ReactNode {
  const color = tone === "info" ? theme.warning : theme.error;
  const glyph = tone === "info" ? "⊘ " : "● ";
  return (
    <box style={{ flexDirection: "row", marginTop: 1, marginBottom: 1 }}>
      <text fg={color}>{glyph}</text>
      <box style={{ flexGrow: 1 }}>
        <text fg={color}>{content}</text>
      </box>
    </box>
  );
}
