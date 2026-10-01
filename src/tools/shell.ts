// Shell tool: run a command via the platform shell, combine stdout+stderr, kill the whole tree on timeout.
import { tool } from "@openrouter/agent/tool";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_LINES = 2000;
const MAX_OUTPUT_BYTES = 256 * 1024;

const isWindows = process.platform === "win32";

export const shell = tool({
  name: "shell",
  description:
    "Execute a shell command and return combined stdout+stderr. Output is truncated to the last 2000 lines / 256KB. On timeout the entire process tree is killed.",
  inputSchema: z.object({
    command: z.string().describe("Shell command to execute"),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`),
  }),
  execute: async ({ command, timeout }) => {
    const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;
    // cmd /c keeps it native on Windows; bash -c covers POSIX. Shell parses the full command string.
    const [bin, args] = isWindows ? ["cmd.exe", ["/d", "/s", "/c", command]] : ["/bin/bash", ["-c", command]];

    const child = spawn(bin, args, {
      windowsHide: true,
      // A detached child gets its own process group on POSIX, so we can signal the whole tree.
      detached: !isWindows,
    });

    return await collectOutput(child, timeoutMs);
  },
});

interface ShellResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

function collectOutput(child: ChildProcess, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolveResult) => {
    const chunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const onData = (buf: Buffer) => chunks.push(buf);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData); // merge stderr into the same stream the model reads

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const { output, truncated } = truncateOutput(Buffer.concat(chunks));
      resolveResult({ output, exitCode, timedOut, truncated });
    };

    child.on("error", (err) => {
      chunks.push(Buffer.from(`\n[spawn error] ${err.message}\n`));
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/** Kill the child AND its descendants — a bare child.kill() leaves orphaned grandchildren running. */
function killTree(child: ChildProcess): void {
  if (child.pid == null) return;
  if (isWindows) {
    // taskkill /T walks the tree; /F forces. Fire-and-forget — the close event will still resolve.
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
    return;
  }
  try {
    // Negative pid signals the whole process group created via detached:true.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Keep only the last MAX_OUTPUT_LINES and MAX_OUTPUT_BYTES — most-recent output is what matters. */
function truncateOutput(buf: Buffer): { output: string; truncated: boolean } {
  let truncated = false;

  let sliced = buf;
  if (sliced.length > MAX_OUTPUT_BYTES) {
    sliced = sliced.subarray(sliced.length - MAX_OUTPUT_BYTES);
    truncated = true;
  }

  let text = sliced.toString("utf8");
  const lines = text.split("\n");
  if (lines.length > MAX_OUTPUT_LINES) {
    text = lines.slice(lines.length - MAX_OUTPUT_LINES).join("\n");
    truncated = true;
  }

  if (truncated) {
    text = `[output truncated to last ${MAX_OUTPUT_LINES} lines / ${MAX_OUTPUT_BYTES / 1024}KB]\n${text}`;
  }
  return { output: text, truncated };
}
