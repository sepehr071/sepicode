// Tool registry. `as const` preserves the tuple type so callModel can infer per-tool input/output.
import { file_edit, file_read, file_write } from "./file.ts";
import { glob, grep, list_dir } from "./search.ts";
import { shell } from "./shell.ts";
import { sub_agent } from "./subagent.ts";
import { web_search } from "./web.ts";

export { file_read, file_write, file_edit } from "./file.ts";
export { glob, grep, list_dir } from "./search.ts";
export { shell } from "./shell.ts";
export { web_search } from "./web.ts";
export { sub_agent } from "./subagent.ts";

export const allTools = [
  file_read,
  file_write,
  file_edit,
  glob,
  grep,
  list_dir,
  shell,
  web_search,
  sub_agent,
] as const;
