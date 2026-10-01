// Input-box parsing for the prompt line: dispatch sigils (`!` shell, `/`
// command), `@file` reference expansion, and an up/down history ring buffer.
// Pure string work plus one async file read — no UI or agent coupling.

import { readFile } from "node:fs/promises";

/** Classification of a raw input line by its leading sigil. */
export interface ParsedInput {
  kind: "prompt" | "shell" | "command";
  value: string;
}

/**
 * Classify a raw input line. A leading `!` means "run as shell", a leading `/`
 * means "slash command"; anything else is a prompt for the model. The sigil is
 * stripped from `value` so callers receive the bare payload.
 */
export function parseInput(raw: string): ParsedInput {
  // Preserve leading whitespace significance only for prompts; a sigil is only a
  // sigil at column zero, matching how shells/REPLs treat command prefixes.
  if (raw.startsWith("!")) return { kind: "shell", value: raw.slice(1) };
  if (raw.startsWith("/")) return { kind: "command", value: raw.slice(1) };
  return { kind: "prompt", value: raw };
}

// `@path` or `@"quoted path with spaces"`. The quoted form wins when present so
// spaces inside quotes don't terminate the token. Unquoted paths stop at the
// first whitespace.
const FILE_REF = /@(?:"([^"]+)"|([^\s"]+))/g;

/**
 * Inline `@file` references as fenced code blocks so the model sees file content
 * in context. Missing/unreadable paths are left verbatim with a trailing note
 * (rather than dropped) so the user can see the reference didn't resolve.
 */
export async function expandFileRefs(text: string): Promise<string> {
  // Collect matches first; doing async reads inside String.replace isn't
  // possible, so we resolve all reads in parallel, then splice results back in.
  const matches = [...text.matchAll(FILE_REF)];
  if (matches.length === 0) return text;

  const replacements = await Promise.all(
    matches.map(async (m) => {
      const path = m[1] ?? m[2] ?? "";
      try {
        const content = await readFile(path, "utf8");
        return `\n\`\`\`${path}\n${content}\n\`\`\`\n`;
      } catch {
        // Leave the original token intact so the user notices the miss.
        return `${m[0]} (file not found)`;
      }
    }),
  );

  // Rebuild left-to-right using match indices so untouched spans are preserved
  // and overlapping/global-regex offsets stay correct.
  let out = "";
  let cursor = 0;
  matches.forEach((m, i) => {
    const start = m.index ?? 0;
    out += text.slice(cursor, start) + replacements[i];
    cursor = start + m[0].length;
  });
  out += text.slice(cursor);
  return out;
}

/** Up/down input-history navigator (the `prev`/`next` of a shell prompt). */
export interface History {
  /** Record a submitted entry and reset the navigation cursor to the end. */
  push(s: string): void;
  /** Move toward older entries; null when already at the oldest. */
  prev(): string | null;
  /** Move toward newer entries; null when back past the newest. */
  next(): string | null;
  /** Reset the cursor to the end (the live, un-submitted line). */
  reset(): void;
}

/**
 * Ring-buffer-style history. `cursor === items.length` is the "live line"
 * position (nothing selected); `prev` walks backward into older entries and
 * `next` walks forward, returning `""` when it lands back on the live line.
 */
export function makeHistory(limit = 200): History {
  const items: string[] = [];
  let cursor = 0;

  return {
    push(s: string): void {
      // Skip empties and consecutive duplicates — they add no recall value.
      if (s && items[items.length - 1] !== s) {
        items.push(s);
        if (items.length > limit) items.shift();
      }
      cursor = items.length;
    },
    prev(): string | null {
      if (cursor === 0) return null;
      cursor -= 1;
      return items[cursor] ?? null;
    },
    next(): string | null {
      if (cursor >= items.length) return null;
      cursor += 1;
      // Stepping past the newest entry returns to the empty live line.
      return cursor === items.length ? "" : (items[cursor] ?? null);
    },
    reset(): void {
      cursor = items.length;
    },
  };
}
