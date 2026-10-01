/** @jsxImportSource @opentui/react */
// One tool invocation in the transcript. Renders a compact two-line group:
//
//   ● Edit  auth.ts
//   └ refactored token expiry check
//
// plus a syntax-highlighted unified diff underneath when the result carried one
// (file_edit). The leading dot is the status light: a spinner frame while running,
// then green/red once the result lands.

import { TextAttributes } from "@opentui/core";
import type { SyntaxStyle } from "@opentui/core";
import { useEffect, useState } from "react";
import { theme } from "../theme.ts";
import type { ToolCallView } from "../types.ts";

export interface ToolCallProps {
  tool: ToolCallView;
  syntaxStyle: SyntaxStyle;
}

// Braille spinner — dense enough to read as motion at the renderer's frame cadence.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;

export function ToolCall({ tool, syntaxStyle }: ToolCallProps): React.ReactNode {
  const frame = useSpinnerFrame(tool.status === "running");

  const glyph =
    tool.status === "running" ? SPINNER_FRAMES[frame] : tool.status === "error" ? "✖" : "●";
  const glyphColor =
    tool.status === "running"
      ? theme.toolRunning
      : tool.status === "error"
        ? theme.error
        : theme.success;

  const summary = summarize(tool);

  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      {/* Header: status light + tool name + inline target (file/query). */}
      <box style={{ flexDirection: "row" }}>
        <text fg={glyphColor}>{glyph} </text>
        <text fg={theme.tool} attributes={TextAttributes.BOLD}>
          {tool.name}
        </text>
        {summary !== undefined && <text fg={theme.muted}>{`  ${summary}`}</text>}
      </box>

      {/* Detail branch: error text takes priority, else a one-line result preview. */}
      {tool.status === "error" ? (
        <BranchLine color={theme.error} text={errorText(tool.result)} />
      ) : tool.diff === undefined ? (
        renderResultPreview(tool)
      ) : null}

      {/* Unified diff for edits, rendered with the shared Mocha syntax theme. */}
      {tool.diff !== undefined && (
        <box style={{ marginTop: 0, marginLeft: 2 }}>
          <diff
            diff={tool.diff}
            syntaxStyle={syntaxStyle}
            view="unified"
            addedSignColor={theme.diffAdd}
            removedSignColor={theme.diffRemove}
            wrapMode="none"
          />
        </box>
      )}
    </box>
  );
}

/** A `└ …` detail line under the header, in the supplied color. */
function BranchLine({ color, text }: { color: string; text: string }): React.ReactNode {
  if (text.length === 0) return null;
  return (
    <box style={{ flexDirection: "row" }}>
      <text fg={theme.dim}>{"└ "}</text>
      <box style={{ flexGrow: 1 }}>
        <text fg={color}>{text}</text>
      </box>
    </box>
  );
}

/** Show a short, single-line preview of a successful, non-diff result. */
function renderResultPreview(tool: ToolCallView): React.ReactNode {
  if (tool.status !== "done") return null;
  const preview = resultPreview(tool.result);
  if (preview.length === 0) return null;
  return <BranchLine color={theme.dim} text={preview} />;
}

/** Run a spinner frame counter only while `active`; cleans up its interval on stop. */
function useSpinnerFrame(active: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active]);
  return frame;
}

/**
 * Build the inline header target from the tool args — the file path for file
 * tools, the query/pattern for search, the command for shell. Best-effort: args
 * are model-authored JSON, so we probe the conventional keys and stop at the
 * first hit.
 */
function summarize(tool: ToolCallView): string | undefined {
  const args = tool.args;
  if (!args || typeof args !== "object") {
    return typeof args === "string" && args.length > 0 ? truncate(args, 60) : undefined;
  }
  const record = args as Record<string, unknown>;
  const candidate =
    pickString(record, "path") ??
    pickString(record, "file") ??
    pickString(record, "filePath") ??
    pickString(record, "pattern") ??
    pickString(record, "query") ??
    pickString(record, "command") ??
    pickString(record, "url");
  return candidate === undefined ? undefined : truncate(candidate, 60);
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Pull the error message out of the SDK's `{ error: string }` envelope. */
function errorText(result: unknown): string {
  if (result && typeof result === "object" && "error" in result) {
    const message = (result as { error: unknown }).error;
    if (typeof message === "string") return truncate(message, 120);
  }
  return "tool failed";
}

/** A terse first-line preview of an arbitrary tool result payload. */
function resultPreview(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return truncate(firstLine(result), 80);
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    // Structured results (search/list/read/write) read better as a count than a raw line.
    if (typeof record.count === "number") {
      return `${record.count} result${record.count === 1 ? "" : "s"}${record.truncated === true ? " (capped)" : ""}`;
    }
    if (typeof record.totalLines === "number") return `${record.totalLines} lines`;
    if (typeof record.bytes === "number") return `wrote ${record.bytes} bytes`;
    const text = record.output ?? record.content ?? record.text ?? record.result;
    if (typeof text === "string") return truncate(firstLine(text), 80);
  }
  return "";
}

function firstLine(value: string): string {
  const idx = value.indexOf("\n");
  return idx === -1 ? value : value.slice(0, idx);
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
