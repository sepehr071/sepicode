# sepicode — Coding Agent TUI Design

**Date:** 2026-06-21
**Status:** Approved
**Author:** Sepehr Radmard (+ Claude)

## Summary

`sepicode` is a strong terminal coding agent with a modern, polished TUI. It runs on **Bun**, uses **`@openrouter/agent`** for the agent loop and **`@opentui/react`** for the UI. Default brain is **`anthropic/claude-opus-4.8`** (swappable at runtime). It operates **full-auto** (no approval gates) with a full coding toolkit.

## Locked Decisions

| Area | Decision |
|---|---|
| Runtime | Bun 1.3.x (verified: OpenTUI native FFI works on Bun/Windows) |
| Agent loop | `@openrouter/agent` v0.7.x (`callModel`, `tool()`, stop conditions, streaming, state) |
| UI | `@opentui/react` v0.4.x — buffered TUI, streaming markdown, native diffs, scrollbox |
| Default model | `anthropic/claude-opus-4.8`, switchable via `/model` |
| Tools | file read/write/edit, glob, grep, list_dir, shell, web_search (serverTool), sub_agent |
| Autonomy | Full-auto — no `requireApproval` gates |
| Features | JSONL session persistence (+ `/new`/resume), auto-compaction, `@file` inlining, `!shell` shortcut |
| Theme | Catppuccin Mocha |
| Binary name | `sepicode` |
| Tests | None by default (smoke checks only if requested) |

## Architecture

Four layers, each independently understandable and testable, communicating through stable contracts in `src/types.ts`.

### Shared contracts (`src/types.ts`, `src/config.ts`, `src/theme.ts`)
- `AgentEvent` discriminated union — the single bus between agent core and UI:
  `text_delta`, `reasoning_delta`, `tool_call_start`, `tool_call_delta`, `tool_result`, `turn_start`, `turn_end`, `usage`, `error`.
- `Config` — loaded from `.env` + optional config file: `apiKey`, `model`, `maxSteps`, `maxCost`, `theme`, `sessionDir`.
- `theme.ts` — Catppuccin Mocha color tokens consumed by all UI components.

### Agent core (`src/agent/`)
- `runner.ts` — wraps `callModel`: holds conversation `state`, sets `stopWhen: [stepCountIs(maxSteps), maxCost(maxCost)]`, default model from config. Consumes the SDK's concurrent streams (`getTextStream`, `getToolStream`, `getFullResponsesStream`, `getResponse`) and re-emits them as `AgentEvent`s on an async event bus. Returns updated `state` for the next turn.
- `events.ts` — `AgentEvent` types + a tiny typed emitter.

### Tools (`src/tools/`)
zod 4 schemas, `tools: [...] as const`. Full-auto (no approval predicates). Proven edge cases from the OpenRouter `create-agent-tui` reference specs:
- `file.ts` — `file_read` (≤2000 lines, per-line truncate >2000 chars, `nextOffset` continuation, base64 image detect), `file_write` (`mkdir -p` then write), `file_edit` (each `old_text` matches exactly once, returns unified diff).
- `search.ts` — `glob` (respects `.gitignore`, cap 1000), `grep` (`rg` if present, Node `RegExp` fallback, cap 100), `list_dir` (`/` suffix on dirs, cap 500).
- `shell.ts` — `shell` (`execFile` via `$SHELL`/`cmd`, combined stdout+stderr, 120s timeout, kill process tree, truncate last 2000 lines/256KB → `{output, exitCode, timedOut}`).
- `web.ts` — `serverTool({ type: 'openrouter:web_search' })`.
- `subagent.ts` — `sub_agent` spawns a child `callModel` with a read-only tool subset and lower `maxSteps`/`maxCost`.
- `index.ts` — registry assembled `as const`.

### Harness (`src/harness/`)
- `session.ts` — append-only JSONL per session in `sessionDir`; list/resume; `/new` starts fresh.
- `compaction.ts` — when token usage nears the model's context window, summarize older turns into a compact synthetic message; keep recent turns verbatim.
- `commands.ts` — slash command registry: `/model`, `/new`, `/help`, `/sessions`.
- `input.ts` — parse user input: `@path` inlines file contents into the prompt; `!cmd` runs a shell command directly; maintains input history.

### TUI (`src/ui/`, `src/cli.tsx`, `bin/sepicode.ts`)
`@opentui/react` components, Catppuccin Mocha:
- `App.tsx` — root layout (`<box flexDirection=column>`), owns message + status state, subscribes to the `AgentEvent` bus.
- `MessageList.tsx` — `<scrollbox>` of messages; flicker-free, independently scrollable.
- `Message.tsx` — streaming markdown renderable (`streaming: true` while tokens arrive, then finalize).
- `ToolCall.tsx` — grouped tool display (`● Ran <tool>` + `└` branches); renders `file_edit` results via native `DiffRenderable`.
- `StatusLine.tsx` — `model · tokens · $cost`.
- `PromptInput.tsx` — `<input>` with history, `@file` and `!shell` affordances.
- `cli.tsx` — entry: load config → if no API key, onboarding screen → else `render(<App/>)`.
- `bin/sepicode.ts` — thin bin shim invoking `cli.tsx` under Bun.

## Data Flow

```
keypress → PromptInput → harness.input (parse @file / !shell / slash)
  → agent.runner.run(input, state)
    → callModel streams → AgentEvent bus
      → App React state → OpenTUI render (messages, tool diffs, status)
  → tools execute in-loop (SDK) → tool_result events → ToolCall/Diff render
  → turn_end → updated state persisted to session JSONL
```

## Error Handling
- Missing `OPENROUTER_API_KEY` → onboarding screen with instructions, no crash.
- Model/provider errors (rate-limit, downtime) → surfaced in status line; optional `models[]` fallback chain later.
- Tool errors (missing file, edit mismatch, shell non-zero) → returned to the model as structured tool results so it can self-recover.
- Shell timeout → kill process tree, return `timedOut: true`.

## Project Layout
```
sepicode/
  package.json  tsconfig.json  .env.example  bin/sepicode.ts
  src/
    cli.tsx  config.ts  theme.ts  types.ts
    agent/   runner.ts  events.ts
    tools/   index.ts file.ts search.ts shell.ts web.ts subagent.ts
    harness/ session.ts compaction.ts commands.ts input.ts
    ui/      App.tsx MessageList.tsx Message.tsx ToolCall.tsx StatusLine.tsx PromptInput.tsx
```

## Definition of Done (v1)
`sepicode` launches → Catppuccin TUI + banner → coding request streams from Opus 4.8 → file/shell tools run full-auto → edits render as diffs → tokens+cost in status line → sessions persist/resume → `@file`, `!cmd`, `/model`, auto-compaction all functional.

## Risks
1. ~~OpenTUI native FFI on Bun/Windows~~ — **VALIDATED** 2026-06-21 (renderer instantiates, emits control sequences, cleans up).
2. OpenTUI is pre-1.0 (0.4.1) — pin exact versions; breaking changes possible on upgrade.
3. Requires `OPENROUTER_API_KEY` before it can run live (onboarding handles absence gracefully).

## Build Plan (parallel)
- Wave 1 (sequential): shared contracts + scaffold (`types.ts`, `config.ts`, `theme.ts`, `package.json`, `tsconfig.json`, entry stubs).
- Wave 2 (parallel, 4 agents): Tools · Agent core · Harness · UI — each owns its directory, builds against Wave-1 contracts.
- Wave 3: integration + smoke test.
