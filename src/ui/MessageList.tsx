/** @jsxImportSource @opentui/react */
// The scrollable transcript: a top banner box framing the conversation, then the
// interleaved timeline of messages and tool calls. Uses ScrollBox's native sticky
// scroll so new content keeps the viewport pinned to the bottom without us doing
// imperative scroll math (which flickers and fights the reconciler).

import type { ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import { theme } from "../theme.ts";
import type { TimelineItem } from "../types.ts";
import { Message } from "./Message.tsx";
import { ToolCall } from "./ToolCall.tsx";

export interface MessageListProps {
  timeline: TimelineItem[];
  syntaxStyle: SyntaxStyle;
  /** Shown right-aligned in the frame title, e.g. `opus-4.8`. */
  model: string;
  /** Ref to the scrollbox so App can drive PageUp/PageDown scrolling. */
  scrollRef: React.RefObject<ScrollBoxRenderable | null>;
}

export function MessageList({
  timeline,
  syntaxStyle,
  model,
  scrollRef,
}: MessageListProps): React.ReactNode {
  return (
    <box
      style={{
        flexGrow: 1,
        flexDirection: "column",
        border: true,
        borderColor: theme.border,
        backgroundColor: theme.bg,
      }}
      title=" sepicode "
      titleColor={theme.accent}
      bottomTitle={` ${model} `}
      bottomTitleAlignment="right"
    >
      <scrollbox
        ref={scrollRef}
        focused={false}
        stickyScroll
        stickyStart="bottom"
        style={{
          flexGrow: 1,
          rootOptions: { backgroundColor: theme.bg },
          wrapperOptions: { backgroundColor: theme.bg },
          viewportOptions: { backgroundColor: theme.bg },
          contentOptions: {
            backgroundColor: theme.bg,
            flexDirection: "column",
            paddingLeft: 1,
            paddingRight: 1,
            gap: 0,
          },
          scrollbarOptions: {
            trackOptions: {
              foregroundColor: theme.border,
              backgroundColor: theme.bg,
            },
          },
        }}
      >
        {timeline.length === 0 ? (
          <EmptyState />
        ) : (
          timeline.map((item) =>
            item.kind === "message" ? (
              <Message key={item.id} message={item} syntaxStyle={syntaxStyle} />
            ) : (
              <ToolCall key={item.id} tool={item} syntaxStyle={syntaxStyle} />
            ),
          )
        )}
      </scrollbox>
    </box>
  );
}

// Wordmark in the figlet "future" box-drawing font — renders in any terminal font.
const WORDMARK = [
  "┏━┓┏━╸┏━┓╻┏━╸┏━┓╺┳┓┏━╸",
  "┗━┓┣╸ ┣━┛┃┃  ┃ ┃ ┃┃┣╸ ",
  "┗━┛┗━╸╹  ╹┗━╸┗━┛╺┻┛┗━╸",
];

const HINTS: [string, string][] = [
  ["@path", "attach a file to your message"],
  ["!command", "run a shell command directly"],
  ["/model", "show or switch the model"],
  ["/resume", "pick up a past session"],
  ["Esc", "interrupt the current turn"],
];

/** Welcome screen before the first turn — keeps the empty transcript from
 *  reading as a render bug and shows the input mini-language at a glance. */
function EmptyState(): React.ReactNode {
  return (
    <box style={{ flexDirection: "column", paddingTop: 1, paddingLeft: 1 }}>
      <box style={{ flexDirection: "row", gap: 3 }}>
        <box style={{ flexDirection: "column" }}>
          {WORDMARK.map((line, i) => (
            <text key={i} fg={theme.accent}>
              {line}
            </text>
          ))}
        </box>
        <box style={{ flexDirection: "column", justifyContent: "flex-end" }}>
          <text fg={theme.fg}>terminal coding agent</text>
          <text fg={theme.dim}>{process.cwd()}</text>
        </box>
      </box>

      <box style={{ marginTop: 1 }}>
        <text fg={theme.muted}>Ask for a change, a fix or an explanation. It reads, edits, searches and runs commands in this directory.</text>
      </box>

      <box style={{ flexDirection: "column", marginTop: 1 }}>
        {HINTS.map(([key, desc]) => (
          <box key={key} style={{ flexDirection: "row" }}>
            <text fg={theme.user}>{`  ${key.padEnd(10)}`}</text>
            <text fg={theme.dim}>{desc}</text>
          </box>
        ))}
      </box>
    </box>
  );
}
