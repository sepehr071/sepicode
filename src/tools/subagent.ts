// Sub-agent tool: delegate a focused task to a child agent with a READ-ONLY tool subset and
// tight step/cost bounds, then return the child's final text. Self-contained — owns its client.
import { tool } from "@openrouter/agent/tool";
import { callModel, maxCost, OpenRouter, stepCountIs } from "@openrouter/agent";
import { z } from "zod";
import { file_read } from "./file.ts";
import { glob, grep, list_dir } from "./search.ts";

// Read-only subset: the child can investigate the codebase but never mutate it.
const READ_ONLY_TOOLS = [file_read, glob, grep, list_dir] as const;

// Lower ceilings than the parent so a delegated task can't run away.
const SUB_AGENT_MAX_STEPS = 8;
const SUB_AGENT_MAX_COST = 0.25;
const SUB_AGENT_MODEL = process.env.SEPICODE_SUBAGENT_MODEL?.trim() || "anthropic/claude-opus-4.8";

const SYSTEM_PROMPT =
  "You are a focused sub-agent with READ-ONLY access (file_read, glob, grep, list_dir). " +
  "Investigate the codebase to answer the delegated task, then reply with a concise, self-contained summary. " +
  "You cannot write, edit, or run commands.";

export const sub_agent = tool({
  name: "sub_agent",
  description:
    "Delegate a focused, read-only investigation to a child agent (file_read, glob, grep, list_dir). Returns the child's final text answer.",
  inputSchema: z.object({
    task: z.string().describe("Detailed instructions for the sub-agent to investigate and answer"),
  }),
  execute: async ({ task }) => {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set — sub_agent cannot spawn a child agent.");
    }

    const client = new OpenRouter({ apiKey });
    const result = callModel(client, {
      model: SUB_AGENT_MODEL,
      instructions: SYSTEM_PROMPT,
      input: task,
      tools: READ_ONLY_TOOLS,
      // Force a closing natural-language turn so we always get a summary, not a dangling tool call.
      allowFinalResponse: true,
      stopWhen: [stepCountIs(SUB_AGENT_MAX_STEPS), maxCost(SUB_AGENT_MAX_COST)],
    });

    const text = await result.getText();
    return { task, text };
  },
});
