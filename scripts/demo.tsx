// Offline demo: mounts the real TUI (App and every UI component) but replaces the
// agent with a scripted `send` that replays a canned event stream. No API key, no
// network, no files touched. Used for README screenshots: `bun run demo`.
// Slash commands go through the real command handler; any prompt plays the script.
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { loadConfig } from "../src/config.ts";
import { handleCommand } from "../src/harness/commands.ts";
import { App } from "../src/ui/App.tsx";
import type { AgentEvent, AgentEventHandler } from "../src/types.ts";

// Screenshot captures show a neutral working directory instead of the local checkout path.
const demoCwd = process.env.SEPICODE_DEMO_CWD;
if (demoCwd) process.cwd = () => demoCwd;

const config = { ...loadConfig(), apiKey: "demo" };
let model = config.model;

const DIFF = `--- a/src/ui/StatusLine.tsx
+++ b/src/ui/StatusLine.tsx
@@ -74,6 +74,7 @@
 }

-/** Two-decimal dollars; sub-cent costs still render as \`$0.00\` for stability. */
+/** Two-decimal dollars; sub-cent costs get a third decimal so they never read as free. */
 function formatCost(cost: number): string {
+  if (cost > 0 && cost < 0.01) return \`$\${cost.toFixed(3)}\`;
   return \`$\${cost.toFixed(2)}\`;
 }`;

const SUMMARY = `Sub-cent turns now show a third decimal instead of \`$0.00\`.

**Changed** \`src/ui/StatusLine.tsx\`
- \`formatCost\` returns \`$0.004\`-style values when \`0 < cost < 0.01\`
- everything at or above one cent keeps the fixed two-decimal width

\`bun run typecheck\` passes. No other file formats dollar amounts.`;

// [delay before event in ms, event]
const SCRIPT: [number, AgentEvent][] = [
  [0, { type: "turn_start" }],
  [400, { type: "tool_call_start", id: "t1", name: "grep", args: { pattern: "formatCost", path: "src" } }],
  [700, { type: "tool_result", id: "t1", name: "grep", result: { matches: [], count: 2, truncated: false } }],
  [300, { type: "tool_call_start", id: "t2", name: "file_read", args: { path: "src/ui/StatusLine.tsx" } }],
  [600, { type: "tool_result", id: "t2", name: "file_read", result: { type: "text", totalLines: 79 } }],
  [300, { type: "tool_call_start", id: "t3", name: "file_edit", args: { path: "src/ui/StatusLine.tsx" } }],
  [900, { type: "tool_result", id: "t3", name: "file_edit", result: { path: "src/ui/StatusLine.tsx", diff: DIFF } }],
  [300, { type: "tool_call_start", id: "t4", name: "shell", args: { command: "bun run typecheck" } }],
  [1800, { type: "tool_result", id: "t4", name: "shell", result: { output: "$ tsc --noEmit", exitCode: 0 } }],
  [200, { type: "usage", usage: { inputTokens: 18240, outputTokens: 1130, totalTokens: 19370, cost: 0.11 } }],
  ...SUMMARY.split(/(?<=\s)/).map((w): [number, AgentEvent] => [25, { type: "text_delta", text: w }]),
  [100, { type: "turn_end" }],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(raw: string, emit: AgentEventHandler, signal?: AbortSignal): Promise<void> {
  if (raw.startsWith("/")) {
    const out = await handleCommand(raw.slice(1), {
      config,
      getModel: () => model,
      setModel: (m) => void (model = m),
      newSession: () => {},
      listSessions: () => [],
      resumeSession: () => ({ ok: false, message: "Sessions are disabled in the demo." }),
    });
    emit({ type: "turn_start" });
    emit({ type: "text_delta", text: out.text });
    emit({ type: "turn_end" });
    return;
  }
  for (const [delay, event] of SCRIPT) {
    await sleep(delay);
    if (signal?.aborted) {
      emit({ type: "notice", message: "Interrupted." });
      emit({ type: "turn_end" });
      return;
    }
    emit(event);
  }
}

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<App config={config} send={send} />);
