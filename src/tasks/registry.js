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
import { runBrowser, renderBrowser } from "./browser.js";

/** Steps the Mac may post in one browser task (A89): the step route refuses the 26th. */
export const BROWSER_MAX_STEPS = 25;

/** Rides in every instance's params, so a later reader of a row can tell which code ran it. */
export const TASK_VERSION = 1;

/** USD per million tokens; cents per search. The ledger's estimate, not a bill. */
export const PRICES = {
  "claude-sonnet-5": { in: 2.0, out: 10.0, cacheRead: 0.2 },
  "claude-opus-5": { in: 5.0, out: 25.0, cacheRead: 0.5 },
  webSearchCents: 1, // $10 per 1,000 searches
};

/** The body keys /v1/tasks/create accepts. An allowlist, so an image can never arrive under a name of its own (A60). */
// `title` (A91): the model's short name for the task, at most six words.
// `mode` and `url` (A89): a browser task's read-or-act, fixed here for good, and its start page.
export const CREATE_KEYS = ["type", "request", "title", "mode", "url", "context", "document", "now", "tz"];
/** A browser task's two modes (A89 §5). Unclear is read; it can never change after create. */
export const BROWSER_MODES = ["read", "act"];
export const URL_MAX_CHARS = 2048;
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
    askAboveSearches: 15,    // the one approval: a plan past this many searches asks first (raised from 6 on 2026-10-12, A83's run: the question is for the big ones)
    maxDurationMs: 30 * 60 * 1000,
    maxSteps: 28,            // start, plan, ask-write, ask-read, up to 20 searches, draft, finish = 26; the test counts the longest path
    costClass: "model",
    model: "claude-sonnet-5",
    retention: "3 days",
    run: runResearch,
    render: renderResearch,
  },
  // A89: the work runs on the Mac; this entry is the ledger and the hold.
  browser: {
    tool: {
      name: "browser",
      description: "Do something on a website in the user's own Chrome: read a page, or fill something in and ask before submitting.",
    },
    needsDocument: false,
    needsUrl: true,
    // The Mac's loop waits on the answer with the window open, so the hold
    // is as long as the idle limit, not a research task's day.
    approvalTimeout: "10 minutes",
    idleTimeout: "10 minutes",
    maxDurationMs: 30 * 60 * 1000,
    maxSteps: BROWSER_MAX_STEPS,
    costClass: "mac",        // the model calls are the Mac's, through the relay; this entry calls no model
    model: null,
    retention: "3 days",
    run: runBrowser,
    render: renderBrowser,
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
