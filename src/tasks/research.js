/**
 * "Research this" (SPEC.md A82): plan, search, draft. The plumbing type — no
 * vendor, one optional approval (a cost gate), a result the app files as a
 * note. PURE: reaches the model only through ctx.model, the platform only
 * through ctx.step and ctx.ask.
 *
 * Step names are deterministic (plan, search-1 … search-N, draft): they are
 * the Workflow's cache keys, and N comes from the plan step's own return
 * value, which the rules permit.
 */
import { costOf, SPOKEN_MAX_CHARS, DETAIL_MAX_BYTES } from "./registry.js";

export const MAX_SEARCHES = 12;
/**
 * What one search step may hand the draft. Measured on the first live run
 * (27ad6d37, 2026-10-11): each step's findings ran to about 2,150 output
 * tokens, about 8,500 characters, and the draft read 21,774 input tokens for
 * ten of them. The step's maxTokens (1,024) and this cap halve both.
 */
const FINDINGS_MAX_CHARS = 4096;

/**
 * Direct web search on the task's model. `allowed_callers: ["direct"]` keeps
 * dynamic filtering's hidden code execution out of the step. Accepted by
 * claude-sonnet-5 on the first live run (2026-10-11: ten search steps, two
 * searches each, about 20,000 input tokens and 8 cents a step), so there is
 * no fallback to the basic `web_search_20250305` and none is coded.
 */
export const WEB_SEARCH = {
  type: "web_search_20260209",
  name: "web_search",
  allowed_callers: ["direct"],
  max_uses: 2,
};

const PLAN_SYSTEM = `You plan a short piece of research for a voice assistant's user. \
Reply with JSON only: {"queries": ["…"], "outline": "one line"}. Between two and twelve \
web search queries, each specific enough to return useful pages. No prose outside the JSON.`;

const SEARCH_SYSTEM = `You research one question for a voice assistant's user using web search. \
Search once; search a second time only if the first results do not answer. Report what you found \
in plain prose, under 250 words, with the facts, figures, dates and the source for each. Say when \
sources disagree. No preamble.`;

const DRAFT_SYSTEM = `You write up research for a voice assistant's user, from findings gathered \
by earlier searches. Reply with JSON only: {"title": "a short note title", "spoken": "one sentence \
the assistant will say out loud, under 200 characters, leading with the answer", "body": "the \
write-up in Markdown: the answer first, then what supports it, then the sources as a list"}. \
No prose outside the JSON.`;

export async function runResearch(ctx) {
  const { request, context } = ctx.task.input;
  const model = ctx.entry.model;
  const question = context ? `${request}\n(Asked while looking at: ${context})` : request;

  const plan = await ctx.step("plan", async () => {
    const reply = await ctx.model({
      system: PLAN_SYSTEM,
      messages: [{ role: "user", content: question }],
      maxTokens: 1024,
    });
    const parsed = parseJSON(reply.text) || {};
    const queries = Array.isArray(parsed.queries)
      ? parsed.queries.filter((q) => typeof q === "string" && q.trim()).map((q) => q.trim()).slice(0, MAX_SEARCHES)
      : [];
    if (queries.length === 0) queries.push(request.slice(0, 200));
    return { queries, outline: typeof parsed.outline === "string" ? parsed.outline.slice(0, 300) : "", cost: costOf(model, reply.usage) };
  }, { timeout: "2 minutes" });

  if (plan.queries.length > ctx.entry.askAboveSearches) {
    await ctx.ask(`This needs about ${plan.queries.length} searches, roughly ${plan.queries.length * ctx.entry.centsPerSearch} cents. Go ahead?`);
  }

  const findings = [];
  for (let i = 0; i < plan.queries.length; i++) {
    const query = plan.queries[i];
    const found = await ctx.step(`search-${i + 1}`, async () => {
      const reply = await ctx.model({
        system: SEARCH_SYSTEM,
        messages: [{ role: "user", content: `The user's question: ${question}\n\nSearch for: ${query}` }],
        tools: [WEB_SEARCH],
        maxTokens: 1024,
      });
      return {
        query,
        findings: reply.text.slice(0, FINDINGS_MAX_CHARS),
        citations: citationsOf(reply.blocks),
        searches: reply.usage.searches,
        cost: costOf(model, reply.usage),
      };
    }, { timeout: "4 minutes" });
    findings.push(found);
  }

  const draft = await ctx.step("draft", async () => {
    const material = findings.map((f, i) =>
      `## Search ${i + 1}: ${f.query}\n${f.findings}\nSources: ${f.citations.join(", ") || "none recorded"}`).join("\n\n");
    const reply = await ctx.model({
      system: DRAFT_SYSTEM,
      messages: [{ role: "user", content: `The user's question: ${question}\nOutline: ${plan.outline}\n\n${material}` }],
      maxTokens: 4096,
    });
    const parsed = parseJSON(reply.text) || {};
    return {
      title: str(parsed.title) || "Research",
      spoken: str(parsed.spoken) || "The research is done; the write-up is in your notes.",
      body: str(parsed.body) || reply.text,
      cost: costOf(model, reply.usage),
    };
  }, { timeout: "4 minutes" });

  return draft;
}

/** One spoken sentence, the detail, and how the app delivers it. */
export function renderResearch(draft) {
  const title = str(draft && draft.title).slice(0, 120) || "Research";
  const body = str(draft && draft.body).slice(0, DETAIL_MAX_BYTES);
  return {
    spoken: str(draft && draft.spoken).slice(0, SPOKEN_MAX_CHARS),
    detail: body,
    deliver: { notes: { title, body } },
  };
}

const str = (v) => (typeof v === "string" ? v.trim() : "");

/** The model was asked for JSON only; a fenced or prefixed reply is still read. */
function parseJSON(text) {
  const raw = str(text);
  if (!raw) return null;
  const candidates = [raw, raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")];
  const brace = raw.indexOf("{");
  if (brace > 0) candidates.push(raw.slice(brace, raw.lastIndexOf("}") + 1));
  for (const candidate of candidates) {
    try { const parsed = JSON.parse(candidate); if (parsed && typeof parsed === "object") return parsed; } catch { /* next */ }
  }
  return null;
}

/** The URLs the search cited, from the result blocks; titles and text stay in the findings prose. */
export function citationsOf(blocks) {
  const urls = new Set();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block && block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const result of block.content) if (result && typeof result.url === "string") urls.add(result.url);
    }
    if (block && block.type === "text" && Array.isArray(block.citations)) {
      for (const citation of block.citations) if (citation && typeof citation.url === "string") urls.add(citation.url);
    }
  }
  return [...urls].slice(0, 20);
}
