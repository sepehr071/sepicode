// File tools: read (paginated + per-line capped + image-aware), write (mkdir -p), edit (exact-match + unified diff).
import { tool } from "@openrouter/agent/tool";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { z } from "zod";

// Caps mirror Claude Code / Pi: bound context so a giant file never floods the model.
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;

const IMAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const file_read = tool({
  name: "file_read",
  description:
    "Read a UTF-8 text file with optional line pagination. Returns content plus a continuation hint when truncated. Images are returned as base64.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or cwd-relative path to the file"),
    offset: z.number().int().min(1).optional().describe("1-indexed first line to read"),
    limit: z.number().int().min(1).optional().describe(`Max lines to read (hard cap ${MAX_LINES})`),
  }),
  execute: async ({ path, offset, limit }) => {
    const ext = extname(path).toLowerCase();
    const mimeType = IMAGE_MIME[ext];
    if (mimeType) {
      // Images can't be line-paginated — hand the model a base64 payload it can render.
      const data = (await readFile(path)).toString("base64");
      return { type: "image" as const, path, mimeType, data };
    }

    const raw = await readFile(path, "utf8");
    const allLines = raw.split("\n");
    const totalLines = allLines.length;

    const start = (offset ?? 1) - 1;
    const requested = limit ?? MAX_LINES;
    const count = Math.min(requested, MAX_LINES);
    const slice = allLines.slice(start, start + count);

    // Per-line truncation dodges minified bundles that would eat the whole budget in one line.
    let perLineTruncated = 0;
    const rendered = slice.map((line) => {
      if (line.length <= MAX_LINE_CHARS) return line;
      perLineTruncated++;
      const dropped = line.length - MAX_LINE_CHARS;
      return `${line.slice(0, MAX_LINE_CHARS)}… [line truncated, ${dropped} chars dropped]`;
    });

    const lastLineRead = start + slice.length;
    const tailTruncated = lastLineRead < totalLines;
    const truncated = tailTruncated || perLineTruncated > 0;

    const hintParts: string[] = [];
    if (tailTruncated) {
      hintParts.push(
        `Showing lines ${start + 1}-${lastLineRead} of ${totalLines}. Use offset=${lastLineRead + 1} to continue.`,
      );
    }
    if (perLineTruncated > 0) {
      hintParts.push(
        `${perLineTruncated} line(s) exceeded ${MAX_LINE_CHARS} chars and were per-line truncated; use grep to fetch content from those lines.`,
      );
    }

    return {
      type: "text" as const,
      path,
      content: rendered.join("\n"),
      totalLines,
      truncated,
      // nextOffset only when the TAIL was cut — line-based paging can't recover per-line truncation.
      ...(tailTruncated ? { nextOffset: lastLineRead + 1 } : {}),
      ...(truncated ? { hint: hintParts.join(" ") } : {}),
    };
  },
});

export const file_write = tool({
  name: "file_write",
  description: "Write content to a file, creating parent directories as needed. Overwrites if it exists.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or cwd-relative path to write"),
    content: z.string().describe("Full file content"),
  }),
  execute: async ({ path, content }) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    return { written: true, path, bytes: Buffer.byteLength(content, "utf8") };
  },
});

export const file_edit = tool({
  name: "file_edit",
  description:
    "Apply exact search-and-replace edits to a file. Each old_text must match exactly once. Returns a unified diff of the change.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or cwd-relative path to edit"),
    edits: z
      .array(
        z.object({
          old_text: z.string().describe("Exact text to find (must occur exactly once)"),
          new_text: z.string().describe("Replacement text"),
        }),
      )
      .min(1)
      .describe("Edits applied sequentially, top to bottom"),
  }),
  execute: async ({ path, edits }) => {
    const original = await readFile(path, "utf8");
    let updated = original;

    for (const [i, { old_text, new_text }] of edits.entries()) {
      if (old_text === new_text) {
        throw new Error(`Edit ${i + 1}: old_text and new_text are identical — no-op.`);
      }
      const first = updated.indexOf(old_text);
      if (first === -1) {
        throw new Error(`Edit ${i + 1}: old_text not found in ${path}.`);
      }
      // Exact-match contract: ambiguous matches are an error, never a silent first-hit replace.
      if (updated.indexOf(old_text, first + 1) !== -1) {
        throw new Error(`Edit ${i + 1}: old_text is ambiguous (matches more than once) in ${path}.`);
      }
      updated = updated.slice(0, first) + new_text + updated.slice(first + old_text.length);
    }

    await writeFile(path, updated, "utf8");
    return { path, diff: unifiedDiff(path, original, updated) };
  },
});

/** Minimal unified diff with grouped hunks + 3 lines of context, so the UI can render the change. */
function unifiedDiff(path: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = lcsDiff(a, b);

  const header = `--- a/${path}\n+++ b/${path}`;
  const context = 3;
  const hunks: string[] = [];

  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === "eq") {
      i++;
      continue;
    }
    // Collect a run of changes, then pad with leading/trailing context.
    let j = i;
    while (j < ops.length) {
      if (ops[j].kind !== "eq") {
        j++;
        continue;
      }
      // Allow up to 2*context equal lines inside a hunk before splitting it.
      let eqRun = 0;
      let k = j;
      while (k < ops.length && ops[k].kind === "eq") {
        eqRun++;
        k++;
      }
      if (eqRun > context * 2 || k === ops.length) break;
      j = k;
    }

    const startCtx = Math.min(context, countLeadingEq(ops, i));
    const endCtx = Math.min(context, countTrailingEq(ops, j));
    const from = i - startCtx;
    const to = j + endCtx;

    let aStart = 0;
    let bStart = 0;
    for (let p = 0; p < from; p++) {
      if (ops[p].kind !== "add") aStart++;
      if (ops[p].kind !== "del") bStart++;
    }

    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    for (let p = from; p < to; p++) {
      const op = ops[p];
      if (op.kind === "eq") {
        body.push(` ${op.line}`);
        aCount++;
        bCount++;
      } else if (op.kind === "del") {
        body.push(`-${op.line}`);
        aCount++;
      } else {
        body.push(`+${op.line}`);
        bCount++;
      }
    }

    hunks.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@\n${body.join("\n")}`);
    i = to;
  }

  return hunks.length ? `${header}\n${hunks.join("\n")}` : `${header}\n(no textual change)`;
}

type DiffOp = { kind: "eq" | "add" | "del"; line: string };

function countLeadingEq(ops: DiffOp[], idx: number): number {
  let n = 0;
  for (let p = idx - 1; p >= 0 && ops[p].kind === "eq"; p--) n++;
  return n;
}

function countTrailingEq(ops: DiffOp[], idx: number): number {
  let n = 0;
  for (let p = idx; p < ops.length && ops[p].kind === "eq"; p++) n++;
  return n;
}

/** Standard LCS diff over line arrays — small files only, which is the file_edit case. */
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", line: a[i] });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", line: a[i++] });
  while (j < m) ops.push({ kind: "add", line: b[j++] });
  return ops;
}
