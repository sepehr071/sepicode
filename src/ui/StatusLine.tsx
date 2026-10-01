/** @jsxImportSource @opentui/react */
// The slim accounting strip between transcript and input:
//
//   ⟳ opus-4.8 · 12k tokens · $0.03
//
// A top border gives the visual separator the sketch calls for. Token count is
// abbreviated (k) past 1000 so it stays a fixed, glanceable width.

import { useEffect, useState } from "react";
import { theme } from "../theme.ts";
import type { Usage } from "../types.ts";

export interface StatusLineProps {
  model: string;
  usage: Usage;
  /** When true, a turn is in flight — shown with an active marker. */
  busy: boolean;
}

export function StatusLine({ model, usage, busy }: StatusLineProps): React.ReactNode {
  const elapsed = useElapsed(busy);
  return (
    <box
      style={{
        flexDirection: "row",
        // 2 rows: the top border takes one, the text needs the other (1 hid the text).
        height: 2,
        flexShrink: 0,
        paddingLeft: 1,
        paddingRight: 1,
        // Top-only border as the separator rule above the input.
        border: ["top"],
        borderColor: theme.border,
        backgroundColor: theme.bg,
        justifyContent: "space-between",
      }}
    >
      <box style={{ flexDirection: "row" }}>
        <text fg={busy ? theme.accent : theme.dim}>{busy ? "⟳ " : "· "}</text>
        <text fg={theme.muted}>{model}</text>
        {busy && <text fg={theme.dim}>{`  ${elapsed}s`}</text>}
      </box>

      <box style={{ flexDirection: "row" }}>
        <text fg={theme.tokens}>{formatTokens(usage.totalTokens)}</text>
        <text fg={theme.dim}>{"  ·  "}</text>
        <text fg={theme.cost}>{formatCost(usage.cost)}</text>
      </box>
    </box>
  );
}

/**
 * Whole-seconds elapsed since `active` last became true; resets to 0 when idle.
 * Gives the user liveness feedback during the dead time before the first token.
 */
function useElapsed(active: boolean): number {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!active) {
      setSecs(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [active]);
  return secs;
}

/** `812` → `812`, `12345` → `12k`, `1200000` → `1.2M`. Keeps width bounded. */
function formatTokens(total: number): string {
  if (total < 1000) return `${total} tokens`;
  if (total < 1_000_000) return `${Math.round(total / 1000)}k tokens`;
  return `${(total / 1_000_000).toFixed(1)}M tokens`;
}

/** Two-decimal dollars; sub-cent costs still render as `$0.00` for stability. */
function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}
