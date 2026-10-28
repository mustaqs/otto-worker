/**
 * One call to the Messages API from a task step (SPEC.md A82).
 *
 * THE SECOND AND LAST READER OF THE KEY. The first is the question path's
 * pass-through in src/index.js, which never reads a response body; this one
 * must — a step wants the whole answer and its usage — and so the README's
 * "never reads a response body" is a claim about the question path.
 * Bench/check-task-path.sh asserts both readers and no third.
 *
 * Non-streaming, bounded at three minutes, and nothing of the request or the
 * reply is logged: a failure line carries the HTTP status and nothing else.
 */
const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const MODEL_TIMEOUT_MS = 180_000;

export async function anthropic(env, model, { system, messages, tools, maxTokens = 4096 }) {
  const key = env.ANTHROPIC_API_KEY; // read once; the only read outside index.js
  if (!key) {
    console.error("task model call: ANTHROPIC_API_KEY is missing");
    throw new Error("model_not_provisioned");
  }
  let response;
  try {
    response = await fetch(ANTHROPIC, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, ...(tools ? { tools } : {}) }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (error) {
    // The class, never the message: a transport error's string form can carry the request.
    console.error(`task model call: unreachable (${error && error.name ? error.name : "error"})`);
    throw new Error("model_unreachable");
  }
  if (!response.ok) {
    // The type and the status, never the message (index.js classifyUpstream's rule).
    let type = "unknown";
    try { const t = ((await response.json()) || {}).error || {}; if (/^[a-z_]{1,40}$/.test(t.type || "")) type = t.type; } catch { /* unknown */ }
    console.error(`task model call: HTTP ${response.status}, ${type}`);
    throw new Error(`model_http_${response.status}`);
  }
  const json = await response.json();
  const u = json && json.usage ? json.usage : {};
  const blocks = Array.isArray(json && json.content) ? json.content : [];
  return {
    text: blocks.filter((b) => b && b.type === "text").map((b) => b.text || "").join(""),
    blocks,
    usage: {
      in: u.input_tokens || 0,
      out: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      searches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
    },
  };
}

/** A 4xx other than 429 will not get better on a retry. */
export function isPermanentModelError(error) {
  const match = /^model_http_(\d{3})$/.exec(error && error.message ? error.message : "");
  if (!match) return false;
  const status = Number(match[1]);
  return status >= 400 && status < 500 && status !== 429;
}
