/**
 * The task types (SPEC.md A82).
 *
 * PURE: the step functions take a context and return values; nothing here
 * imports a platform module, reads `env`, or logs. `src/tasks/workflow.js`
 * binds the platform; `src/tasks/run.js` runs an entry against it; test.mjs
 * drives run.js with a fake step and a scripted model.
 *
 * ADDING A TYPE: one file under src/tasks/, one entry here, one block in
 * test.mjs — and, in the app, one enum value, two lines and a pin (A83).
 */
import { runResearch, renderResearch } from "./research.js";

/** Rides in every instance's params, so a later reader of a row can tell which code ran it. */
export const TASK_VERSION = 1;

/** USD per million tokens; cents per search. The ledger's estimate, not a bill. */
export const PRICES = {
  "claude-sonnet-5": { in: 2.0, out: 10.0, cacheRead: 0.2 },
  "claude-opus-5": { in: 5.0, out: 25.0, cacheRead: 0.5 },
  webSearchCents: 1, // $10 per 1,000 searches
};

/** The body keys /v1/tasks/create accepts. An allowlist, so an image can never arrive under a name of its own (A60). */
export const CREATE_KEYS = ["type", "request", "context", "document", "now", "tz"];
export const REQUEST_MAX_CHARS = 4000;
export const CONTEXT_MAX_CHARS = 300;
export const DOCUMENT_MAX_BYTES = 32768;
export const SPOKEN_MAX_CHARS = 240;
export const DETAIL_MAX_BYTES = 262144;

export const TYPES = {
  research: {
    tool: {
      name: "research",
      description: "Look something up properly: several web searches, read, compare, write it up.",
    },
    needsDocument: false,
    approvalTimeout: "24 hours",
    askAboveSearches: 6,
    centsPerSearch: 5,       // the question's all-in estimate per planned search: 29.5 cents for six on the bounded step's first live run (f97f67a0, 2026-10-12); it was 8.9 before the bounds
    maxDurationMs: 30 * 60 * 1000,
    maxSteps: 20,
    costClass: "model",
    model: "claude-sonnet-5",
    retention: "3 days",
    run: runResearch,
    render: renderResearch,
  },
};

/** The ledger's estimate for one model call, in cents to a tenth. */
export function centsOf(model, usage) {
  const price = PRICES[model];
  if (!price || !usage) return 0;
  const tokens = (Number(usage.in) || 0) * price.in
    + (Number(usage.out) || 0) * price.out
    + (Number(usage.cacheRead) || 0) * price.cacheRead;
  const cents = tokens / 10_000 + (Number(usage.searches) || 0) * PRICES.webSearchCents;
  return Math.round(cents * 10) / 10;
}

/** What a step hands back beside its result so guardedStep can write the ledger entry. */
export function costOf(model, usage) {
  return {
    model,
    in: Number(usage && usage.in) || 0,
    out: Number(usage && usage.out) || 0,
    cacheRead: Number(usage && usage.cacheRead) || 0,
    searches: Number(usage && usage.searches) || 0,
    cents: centsOf(model, usage),
  };
}
