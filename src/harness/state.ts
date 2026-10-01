// Cross-restart app preferences (NOT per-conversation session state). A single
// small JSON file holds things the user expects to stick between launches, like
// the last model they switched to with `/model`. Kept deliberately tiny and
// best-effort: a missing or corrupt file just yields defaults, never a crash.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Persisted preferences. All fields optional so the file can grow over time. */
export interface AppState {
  /** Last model selected via `/model`, used as the default on next launch. */
  lastModel?: string;
}

/** Read persisted state; returns `{}` when the file is absent or unreadable. */
export function loadAppState(path: string): AppState {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as AppState) : {};
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the persisted state and write it back. Best-effort: any IO
 * failure is swallowed so persistence never breaks the running app.
 */
export function saveAppState(path: string, patch: Partial<AppState>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const next: AppState = { ...loadAppState(path), ...patch };
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch {
    // Non-fatal: preferences just won't persist this time.
  }
}
