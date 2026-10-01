// Search tools: glob (file patterns, .gitignore-aware), grep (rg-backed with Node fallback), list_dir.
import { tool } from "@openrouter/agent/tool";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { glob as globAsync } from "glob";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const GLOB_CAP = 1000;
const GREP_CAP = 100;
const LIST_CAP = 500;

// Always-ignored dirs so fallback walks never descend into dependency/VCS noise.
const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];

export const glob = tool({
  name: "glob",
  description: "Find files by glob pattern, respecting .gitignore. Returns relative paths.",
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts"'),
    path: z.string().optional().describe("Directory to search in (default: cwd)"),
  }),
  execute: async ({ pattern, path }) => {
    const cwd = path ? resolve(path) : process.cwd();
    const ignore = [...DEFAULT_IGNORE, ...(await gitignorePatterns(cwd))];
    const matches = await globAsync(pattern, { cwd, nodir: true, dot: false, ignore, posix: true });
    const capped = matches.slice(0, GLOB_CAP);
    return { files: capped, count: capped.length, truncated: matches.length > GLOB_CAP };
  },
});

export const grep = tool({
  name: "grep",
  description:
    "Search file contents by regex. Uses ripgrep when on PATH, else a Node fallback. Returns {file, line, content}.",
  inputSchema: z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    path: z.string().optional().describe("Directory or file to search (default: cwd)"),
    glob: z.string().optional().describe('File filter, e.g. "*.ts"'),
    ignoreCase: z.boolean().optional(),
  }),
  execute: async ({ pattern, path, glob: globFilter, ignoreCase }) => {
    const root = path ? resolve(path) : process.cwd();
    const viaRg = await rgGrep(pattern, root, globFilter, ignoreCase);
    const matches = viaRg ?? (await nodeGrep(pattern, root, globFilter, ignoreCase));
    const capped = matches.slice(0, GREP_CAP);
    return { matches: capped, count: capped.length, truncated: matches.length > GREP_CAP, engine: viaRg ? "rg" : "node" };
  },
});

export const list_dir = tool({
  name: "list_dir",
  description: "List directory contents, alphabetically sorted with a trailing / on directories.",
  inputSchema: z.object({
    path: z.string().optional().describe("Directory to list (default: cwd)"),
  }),
  execute: async ({ path }) => {
    const dir = path ? resolve(path) : process.cwd();
    const dirents = await readdir(dir, { withFileTypes: true });
    const entries = dirents
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, LIST_CAP);
    return { path: dir, entries, count: entries.length, truncated: dirents.length > LIST_CAP };
  },
});

type GrepMatch = { file: string; line: number; content: string };

/** Run ripgrep if it resolves on PATH; return null so the caller falls back when rg is missing. */
async function rgGrep(
  pattern: string,
  root: string,
  globFilter: string | undefined,
  ignoreCase: boolean | undefined,
): Promise<GrepMatch[] | null> {
  const args = ["--json", "--no-messages"];
  if (ignoreCase) args.push("-i");
  if (globFilter) args.push("-g", globFilter);
  args.push("--", pattern, root);

  try {
    // rg exits 1 when there are zero matches — that's success with an empty result, not an error.
    const { stdout } = await execFileAsync("rg", args, { maxBuffer: 32 * 1024 * 1024 }).catch((err) => {
      if (err?.code === 1 && typeof err.stdout === "string") return { stdout: err.stdout };
      throw err;
    });

    const matches: GrepMatch[] = [];
    for (const raw of stdout.split("\n")) {
      if (!raw) continue;
      const ev = JSON.parse(raw) as { type: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
      if (ev.type !== "match" || !ev.data?.path?.text) continue;
      matches.push({
        file: relative(root, ev.data.path.text) || ev.data.path.text,
        line: ev.data.line_number ?? 0,
        content: (ev.data.lines?.text ?? "").replace(/\r?\n$/, ""),
      });
      if (matches.length >= GREP_CAP + 1) break;
    }
    return matches;
  } catch (err) {
    // ENOENT = rg not installed → signal the caller to use the Node fallback.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/** Node fallback: walk the tree, RegExp each text line. Skips binaries and the default-ignored dirs. */
async function nodeGrep(
  pattern: string,
  root: string,
  globFilter: string | undefined,
  ignoreCase: boolean | undefined,
): Promise<GrepMatch[]> {
  const re = new RegExp(pattern, ignoreCase ? "i" : undefined);
  const extFilter = globFilter?.startsWith("*.") ? globFilter.slice(1) : null;
  const matches: GrepMatch[] = [];

  const rootStat = await stat(root);
  const files: string[] = [];
  if (rootStat.isFile()) {
    files.push(root);
  } else {
    await collectFiles(root, files);
  }

  for (const file of files) {
    if (extFilter && !file.endsWith(extFilter)) continue;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue; // unreadable / binary
    }
    if (text.includes("\0")) continue; // NUL byte → treat as binary, skip

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matches.push({ file: relative(root, file) || file, line: i + 1, content: lines[i] });
        if (matches.length >= GREP_CAP + 1) return matches;
      }
    }
  }
  return matches;
}

async function collectFiles(dir: string, out: string[]): Promise<void> {
  const dirents = await readdir(dir, { withFileTypes: true });
  for (const d of dirents) {
    if (d.name === "node_modules" || d.name === ".git") continue;
    const full = join(dir, d.name);
    if (d.isDirectory()) {
      await collectFiles(full, out);
    } else if (d.isFile()) {
      out.push(full);
    }
    if (out.length > 50_000) return; // sanity bound on huge trees
  }
}

/** Parse .gitignore into glob-package ignore patterns. Best-effort: missing file → no extra ignores. */
async function gitignorePatterns(cwd: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  const patterns: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const body = trimmed.replace(/^\/+/, "").replace(new RegExp(`${sep === "\\" ? "\\\\" : sep}+$`), "").replace(/\/+$/, "");
    // Match the entry anywhere in the tree, both as a dir subtree and as a file.
    patterns.push(`**/${body}/**`, `**/${body}`);
  }
  return patterns;
}
