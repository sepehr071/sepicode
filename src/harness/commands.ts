// Slash-command handling. Commands are side-effecting verbs the user types as
// `/name args`; this module owns parsing + rendering, while the actual state
// mutations (switch model, start a session) are injected via CommandContext so
// the harness stays the single owner of session/model lifecycle.

import type { CommandOutput, Config, ResumeResult, SessionInfo } from "../types.ts";

/**
 * Capabilities a command may invoke. Injected so commands.ts never reaches into
 * harness internals directly — the host wires these to its real session/model
 * state.
 */
export interface CommandContext {
  config: Config;
  /** The live, currently-active model (not the immutable startup default). */
  getModel(): string;
  setModel(m: string): void;
  newSession(): void;
  listSessions(): SessionInfo[];
  /** Restore a past session by `/sessions` index or id; mutates live state. */
  resumeSession(selector: string): ResumeResult;
}

/** Registry of commands for `/help` and future autocomplete. */
export const COMMANDS: { name: string; desc: string }[] = [
  { name: "model", desc: "Show the current model, or `/model <slug>` to switch" },
  { name: "new", desc: "Start a fresh session (clears conversation context)" },
  { name: "sessions", desc: "List recent sessions, newest first" },
  { name: "resume", desc: "Resume a past session: `/resume <number|id>`" },
  { name: "help", desc: "List available commands" },
];

/**
 * Execute a slash command. `raw` is the text *after* the leading `/`. Returns a
 * human-readable string the host renders as a system message. Unknown commands
 * yield a hint rather than throwing — a typo shouldn't break the input loop.
 */
export async function handleCommand(
  raw: string,
  ctx: CommandContext,
): Promise<CommandOutput> {
  const trimmed = raw.trim();
  // Split once into command + remainder so args keep their internal spaces.
  const sep = trimmed.search(/\s/);
  const name = (sep === -1 ? trimmed : trimmed.slice(0, sep)).toLowerCase();
  const arg = sep === -1 ? "" : trimmed.slice(sep + 1).trim();

  switch (name) {
    case "model":
      return { text: arg ? switchModel(arg, ctx) : currentModel(ctx) };

    case "new":
      ctx.newSession();
      return { text: "Started a new session." };

    case "sessions":
      return { text: renderSessions(ctx.listSessions()) };

    case "resume":
      return resumeSession(arg, ctx);

    case "help":
    case "":
      return { text: renderHelp() };

    default:
      return { text: `Unknown command: /${name}. Try /help.` };
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function switchModel(slug: string, ctx: CommandContext): string {
  const prev = ctx.getModel();
  if (slug === prev) return `Model already set to ${slug}.`;
  ctx.setModel(slug);
  return `Model: ${prev} → ${slug}`;
}

/** `/model` with no arg: show the live model and how to switch. */
function currentModel(ctx: CommandContext): string {
  return [
    `Current model: ${ctx.getModel()}`,
    "Switch with /model <slug>  ·  e.g. /model anthropic/claude-sonnet-4.6",
  ].join("\n");
}

/** `/resume <selector>`: delegate the restore to the host, surface its result. */
function resumeSession(arg: string, ctx: CommandContext): CommandOutput {
  if (!arg) {
    return { text: "Usage: /resume <number from /sessions | session id>" };
  }
  const result = ctx.resumeSession(arg);
  return result.load ? { text: result.message, load: result.load } : { text: result.message };
}

function renderSessions(sessions: SessionInfo[]): string {
  if (sessions.length === 0) return "No sessions yet.";

  const lines = sessions.slice(0, 20).map((s, i) => {
    const when = new Date(s.startedAt).toLocaleString();
    const preview = s.preview || "(empty)";
    return `${String(i + 1).padStart(2)}. ${when}  ${preview}`;
  });
  return ["Recent sessions:", ...lines, "", "Reopen with /resume <number>."].join("\n");
}

function renderHelp(): string {
  const lines = COMMANDS.map((c) => `  /${c.name.padEnd(10)} ${c.desc}`);
  return ["Commands:", ...lines].join("\n");
}
