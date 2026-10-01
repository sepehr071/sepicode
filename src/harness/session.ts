// JSONL append-only session persistence. Each session is one file under
// `config.sessionDir`; every turn appends one JSON object per line. JSONL is
// chosen over a single JSON document so a crashed/killed process never corrupts
// prior turns — partial last lines are simply skipped on read.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { SessionInfo, SessionLoad, SessionRecord, Usage } from "../types.ts";

/** A live, writable session handle returned by `createSession`. */
export interface Session {
  id: string;
  path: string;
  /** Append one record as a single JSONL line. */
  append(rec: SessionRecord): void;
}

/**
 * Create a fresh session: ensure `dir` exists, mint a sortable id, and write the
 * `meta` record as the first line so the model is recoverable without parsing
 * the whole file.
 */
export function createSession(dir: string, model: string): Session {
  mkdirSync(dir, { recursive: true });

  const id = makeSessionId();
  const path = join(dir, `${id}.jsonl`);

  // Truncate-create the file (writeFileSync) so a recycled id can't inherit a
  // stale tail; every subsequent write is a pure append.
  const meta: SessionRecord = { ts: Date.now(), kind: "meta", model };
  writeFileSync(path, `${JSON.stringify(meta)}\n`, "utf8");

  return {
    id,
    path,
    append(rec: SessionRecord): void {
      appendFileSync(path, `${JSON.stringify(rec)}\n`, "utf8");
    },
  };
}

/**
 * Reopen an existing session file for appending (resume). Unlike `createSession`
 * it does NOT truncate or write a fresh meta line — subsequent turns are appended
 * to the original transcript so the file stays a single continuous conversation.
 */
export function openSession(path: string): Session {
  const id = basename(path).replace(/\.jsonl$/, "");
  return {
    id,
    path,
    append(rec: SessionRecord): void {
      appendFileSync(path, `${JSON.stringify(rec)}\n`, "utf8");
    },
  };
}

// ---------------------------------------------------------------------------
// SDK conversation state — a per-session sidecar so resume restores the model's
// memory, not just the visible transcript. The opaque state from the agent SDK
// is overwritten each turn next to the JSONL (it's not `.jsonl`, so it never
// shows up in listSessions).
// ---------------------------------------------------------------------------

/** Sidecar path for a session's serialized SDK conversation state. */
function statePath(sessionPath: string): string {
  return sessionPath.replace(/\.jsonl$/, ".state.json");
}

/** Persist the latest SDK conversation state for `sessionPath`. Best-effort. */
export function saveSessionState(sessionPath: string, state: unknown): void {
  if (state == null) return;
  try {
    writeFileSync(statePath(sessionPath), JSON.stringify(state), "utf8");
  } catch {
    // Non-fatal: resume will fall back to transcript-only (no model memory).
  }
}

/** Load the SDK conversation state for `sessionPath`, or null if unavailable. */
export function loadSessionState(sessionPath: string): unknown {
  const p = statePath(sessionPath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Rebuild the UI view-state (timeline + latest usage + model) from a session's
 * persisted records, so a resumed conversation renders exactly as it was left.
 * Tool diffs aren't reconstructed (a minor fidelity loss only on resume); tools
 * show their result preview instead.
 */
export function recordsToTimeline(records: SessionRecord[]): SessionLoad {
  const timeline: SessionLoad["timeline"] = [];
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
  let model = "";

  records.forEach((rec, i) => {
    switch (rec.kind) {
      case "meta":
        model = rec.model;
        break;
      case "user":
        timeline.push({ kind: "message", id: `r${i}`, role: "user", content: rec.content });
        break;
      case "assistant":
        timeline.push({
          kind: "message",
          id: `r${i}`,
          role: "assistant",
          content: rec.content,
          streaming: false,
        });
        break;
      case "tool":
        timeline.push({
          kind: "tool",
          id: `r${i}`,
          name: rec.name,
          args: rec.args,
          result: rec.result,
          isError: rec.isError,
          status: rec.isError ? "error" : "done",
        });
        break;
      case "usage":
        usage = rec.usage;
        break;
    }
  });

  return { timeline, usage, model };
}

/**
 * List sessions in `dir`, newest first. Each entry carries a short `preview`
 * (first user message) so a picker can render without re-reading every file in
 * full — we stop scanning a file as soon as the first user line is found.
 */
export function listSessions(dir: string): SessionInfo[] {
  if (!existsSync(dir)) return [];

  const infos: SessionInfo[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;

    const path = join(dir, name);
    const info = readSessionInfo(path, name.slice(0, -".jsonl".length));
    if (info) infos.push(info);
  }

  // Newest first by start timestamp; the id is timestamp-prefixed so this is
  // stable even when two sessions share a `startedAt`.
  infos.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
  return infos;
}

/** Parse a session file back into its records, skipping any unparsable lines. */
export function loadSession(path: string): SessionRecord[] {
  if (!existsSync(path)) return [];

  const records: SessionRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    const rec = tryParse(line);
    if (rec) records.push(rec);
  }
  return records;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Sortable, collision-resistant id: ISO timestamp (filesystem-safe) plus a short
 * random suffix. Lexicographic order matches chronological order, which lets the
 * picker sort by id and keeps filenames human-scannable.
 */
function makeSessionId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

/** Read just enough of a session file to build its `SessionInfo`. */
function readSessionInfo(path: string, id: string): SessionInfo | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let startedAt = statSync(path).mtimeMs;
  let preview = "";

  for (const line of raw.split("\n")) {
    if (!line) continue;
    const rec = tryParse(line);
    if (!rec) continue;

    // The meta line (first line) carries the authoritative start time.
    if (rec.kind === "meta") startedAt = rec.ts;

    if (!preview && rec.kind === "user") {
      preview = oneLine(rec.content);
      break; // first user message is all we need for the preview
    }
  }

  return { id, path, startedAt, preview };
}

/** Collapse whitespace and clamp length so previews fit on one terminal row. */
function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function tryParse(line: string): SessionRecord | null {
  try {
    return JSON.parse(line) as SessionRecord;
  } catch {
    return null;
  }
}
