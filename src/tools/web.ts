// Web search via OpenRouter's server-executed tool. OpenRouter runs the search and returns
// the result item in the response — there is no client-side execute function.
import { serverTool } from "@openrouter/agent/tool";

// `parameters` maps to the SDK's WebSearchConfig (maxResults defaults to 5, maxTotalResults to 50).
// Left unset → provider-native search when available, Exa otherwise.
export const web_search = serverTool({ type: "openrouter:web_search" });
