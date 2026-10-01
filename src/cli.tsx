// Entry point: loads config, wires harness + agent + UI, mounts the OpenTUI app.
// This is the integration layer — the `send` controller is the single bridge the UI
// calls; everything else (agent loop, tools, sessions) hangs off it.
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.ts";
import { createClient, runAgent } from "./agent/runner.ts";
import { buildSystemPrompt } from "./agent/prompt.ts";
import {
  createSession,
  listSessions,
  loadSession,
  loadSessionState,
  openSession,
  recordsToTimeline,
  saveSessionState,
  type Session,
} from "./harness/session.ts";
import { saveAppState } from "./harness/state.ts";
import { parseInput, expandFileRefs } from "./harness/input.ts";
import { handleCommand, type CommandContext } from "./harness/commands.ts";
import { App } from "./ui/App.tsx";
import type { AgentEventHandler, ConversationState, ResumeResult, SessionInfo } from "./types.ts";

const config = loadConfig();

if (!config.apiKey) {
  onboarding();
  process.exit(1);
}

const client = createClient(config.apiKey);

// System prompt is stable for the process (cwd/platform don't change mid-session),
// so build it once and reuse across turns.
const instructions = buildSystemPrompt(process.cwd());

// Mutable session/turn state lives here so the controller closure can thread it
// across turns. The UI is stateless w.r.t. the model — it just calls `send`.
let model = config.model;
let state: ConversationState = null;
let session: Session = createSession(config.sessionDir, model);

const cmdCtx: CommandContext = {
  config,
  getModel: () => model,
  setModel: (m) => {
    model = m;
    // Persist so an explicit /model switch survives a restart (config precedence).
    saveAppState(config.stateFile, { lastModel: m });
  },
  newSession: () => {
    state = null;
    session = createSession(config.sessionDir, model);
  },
  listSessions: () => listSessions(config.sessionDir),
  resumeSession: (selector) => resumeSessionImpl(selector),
};

/**
 * Resume a past session: restore the model's conversation memory (state sidecar),
 * the model it ran with, and reattach the session file for appending. Returns the
 * rebuilt UI view so the caller can repaint the transcript. Resume does NOT persist
 * the model as the new default — only an explicit /model switch does.
 */
function resumeSessionImpl(selector: string): ResumeResult {
  const target = pickSession(listSessions(config.sessionDir), selector);
  if (!target) return { ok: false, message: `No session matches "${selector}". Try /sessions.` };

  const load = recordsToTimeline(loadSession(target.path));
  const restored = loadSessionState(target.path);
  state = (restored ?? null) as ConversationState;
  if (load.model) model = load.model;
  session = openSession(target.path);

  const note = restored ? "" : "  (transcript only — prior model context unavailable)";
  return {
    ok: true,
    message: `Resumed ${target.id} — ${load.timeline.length} items.${note}`,
    load: { ...load, model },
  };
}

/** Resolve a /resume selector: a 1-based number from /sessions, or an id (substring). */
function pickSession(sessions: SessionInfo[], selector: string): SessionInfo | undefined {
  const trimmed = selector.trim();
  if (/^\d+$/.test(trimmed)) return sessions[Number.parseInt(trimmed, 10) - 1];
  return sessions.find((s) => s.id === trimmed) ?? sessions.find((s) => s.id.includes(trimmed));
}

let seq = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;

/**
 * The one bridge the UI calls on every submit. Routes by input kind:
 *  - `/command` → harness command, shown as an assistant line
 *  - `!shell`   → direct shell exec, shown as a tool call
 *  - prompt     → expand @file refs, run the agent loop, persist the turn
 * Never throws — failures surface as an `error` event so the UI clears "busy".
 */
const send: (raw: string, emit: AgentEventHandler, signal?: AbortSignal) => Promise<void> = async (
  raw,
  emit,
  signal,
) => {
  const parsed = parseInput(raw);
  try {
    if (parsed.kind === "command") {
      // Capture the model around the command so a `/model` switch can be pushed to
      // the UI (status line / frame title) — the command itself only mutates the
      // closure model, the UI learns about it via this event.
      const before = model;
      const out = await handleCommand(parsed.value, cmdCtx);
      emit({ type: "turn_start" });
      if (out.load) {
        // /resume repaints the whole transcript (and carries its own model).
        emit({
          type: "session_loaded",
          timeline: out.load.timeline,
          usage: out.load.usage,
          model: out.load.model,
        });
      } else if (model !== before) {
        emit({ type: "model_changed", model });
      }
      emit({ type: "text_delta", text: out.text });
      emit({ type: "turn_end" });
      return;
    }

    if (parsed.kind === "shell") {
      const id = nextId("sh");
      emit({ type: "turn_start" });
      emit({ type: "tool_call_start", id, name: "shell", args: { command: parsed.value } });
      const isWin = process.platform === "win32";
      const res = spawnSync(isWin ? "cmd" : "bash", [isWin ? "/c" : "-c", parsed.value], {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trimEnd();
      const exitCode = res.status ?? -1;
      emit({ type: "tool_result", id, name: "shell", result: { output, exitCode }, isError: exitCode !== 0 });
      session.append({ ts: Date.now(), kind: "tool", name: "shell", args: { command: parsed.value }, result: { output, exitCode } });
      emit({ type: "turn_end" });
      return;
    }

    // Normal prompt → agent loop.
    const expanded = await expandFileRefs(parsed.value);
    session.append({ ts: Date.now(), kind: "user", content: parsed.value });
    const result = await runAgent(
      client,
      {
        input: expanded,
        state,
        model,
        maxSteps: config.maxSteps,
        maxCost: config.maxCost,
        instructions,
        temperature: config.temperature,
        reasoningEffort: config.reasoningEffort,
        signal,
      },
      emit,
    );
    state = result.state;
    // Persist the SDK conversation state so /resume can restore the model's memory.
    saveSessionState(session.path, state);
    session.append({ ts: Date.now(), kind: "assistant", content: result.text });
    session.append({ ts: Date.now(), kind: "usage", usage: result.usage });
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    emit({ type: "turn_end" });
  }
};

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<App config={config} send={send} />);

function onboarding(): void {
  const b = "\x1b[1m";
  const mauve = "\x1b[38;2;203;166;247m";
  const peach = "\x1b[38;2;250;179;135m";
  const dim = "\x1b[38;2;127;132;156m";
  const r = "\x1b[0m";
  process.stdout.write(
    `\n  ${mauve}${b}sepicode${r} ${dim}— terminal coding agent${r}\n\n` +
      `  ${peach}OPENROUTER_API_KEY is not set.${r}\n\n` +
      `  Get a key at ${b}https://openrouter.ai/keys${r} then either:\n` +
      `    ${dim}•${r} copy ${b}.env.example${r} to ${b}.env${r} and paste your key, or\n` +
      `    ${dim}•${r} set it in your shell:\n` +
      `        ${dim}PowerShell:${r} $env:OPENROUTER_API_KEY = "sk-or-..."\n` +
      `        ${dim}bash:${r}       export OPENROUTER_API_KEY="sk-or-..."\n\n` +
      `  Then run ${b}bun start${r} again.\n\n`,
  );
}
