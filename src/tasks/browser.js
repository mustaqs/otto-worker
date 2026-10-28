/**
 * "Do this on a website" (Otto SPEC A89): a task whose work runs on the Mac,
 * in a Chrome window Otto opens, and whose Workflow is a LEDGER, not a
 * worker. The Mac posts each step to /v1/tasks/step; that route writes the
 * step into the row (the truth) and sends the instance a "browser-step"
 * event. This run() waits for that event, reads the row, and does the one
 * thing only the Workflow can: hold an approval through askUser, with the
 * extension's sentence verbatim. A finish entry ends it with the answer.
 *
 * WHY THE ROUTE WRITES AND THE WORKFLOW READS. Cloudflare buffers an event
 * sent while the instance is not waiting ("delivered when the Workflow
 * reaches the waitForEvent step with the matching type", developers.
 * cloudflare.com/workflows/build/events-and-parameters, read 2026-10-28) but
 * does not say whether several buffered events of one type keep their order
 * or coalesce. So an event carries no content — only "a step was posted" —
 * and every decision is taken from the row, which is the same however the
 * events were buffered.
 *
 * PURE: reaches the platform only through ctx.step, ctx.awaitStep, ctx.ask
 * and ctx.row (which only runs inside a step).
 */
import { SPOKEN_MAX_CHARS, BROWSER_MAX_STEPS } from "./registry.js";

/** The ledger's step entries, oldest first: `step-1` … `step-N`. */
export function stepsOf(row) {
  let steps = [];
  try { steps = JSON.parse((row && row.steps) || "[]"); } catch { steps = []; }
  return (Array.isArray(steps) ? steps : [])
    .filter((s) => s && /^step-\d+$/.test(s.name))
    .sort((a, b) => Number(a.name.slice(5)) - Number(b.name.slice(5)));
}

/** What the run needs from the row: the newest posted step. */
export function ledgerView(row) {
  const steps = stepsOf(row);
  const last = steps[steps.length - 1] || null;
  let title = "";
  try { title = String(JSON.parse((row && row.input) || "{}").title || ""); } catch { title = ""; }
  return {
    count: steps.length,
    title,
    last: last ? { n: Number(last.name.slice(5)), kind: last.kind, ask: last.ask || null, answer: last.answer || null } : null,
  };
}

export async function runBrowser(ctx) {
  // One wait per posted step at most, plus slack for an approval's own event:
  // the route refuses a 26th step, so the loop cannot outlive the bound.
  const asked = new Set();
  for (let i = 1; i <= BROWSER_MAX_STEPS + 2; i++) {
    await ctx.awaitStep(i);
    const view = await ctx.step(`read-${i}`, async () => ledgerView(await ctx.row()), { record: false });
    const last = view.last;
    if (!last) continue;
    if (last.kind === "finish") return { answer: last.answer || "", title: view.title };
    if (last.kind === "approval" && last.ask && !asked.has(last.n)) {
      asked.add(last.n);
      // THE EXTENSION'S SENTENCE, VERBATIM (A89 §6): built from what the
      // browser will send, never the model's words. Keyed by the step, so a
      // task may hold more than one approval and each has its own steps.
      await ctx.ask(last.ask, `step-${last.n}`);
    }
  }
  throw Object.assign(new Error("step_limit"), { name: "TaskStepLimit" });
}

/** How long a finished answer may be: the spoken sentence, or more to file. */
export const ANSWER_MAX = 1500;

/**
 * The answer, said once on the next question (A83, A91). A short one is said
 * whole and nothing is filed. A long one — past one spoken sentence's 240
 * characters — is said as its first sentence, and the whole answer is filed
 * to the user's notes under the task's title, as research is.
 */
export function renderBrowser(out) {
  const answer = typeof (out && out.answer) === "string" ? out.answer.trim() : "";
  if (answer.length <= SPOKEN_MAX_CHARS) return { spoken: answer || "I've finished in Chrome.", detail: "" };
  const first = (answer.match(/^.*?[.!?](?=\s|$)/) || [answer])[0].slice(0, SPOKEN_MAX_CHARS);
  const title = (typeof out.title === "string" && out.title.trim()) || "From Chrome";
  return { spoken: first, detail: answer, deliver: { notes: { title, body: answer } } };
}

// ------------------------------------------------------------- the ledger's words

/** What a posted step may say (A89 §7): labels, an approval sentence, an answer. */
export const STEP_KEYS = ["id", "n", "kind", "label", "sentence", "answer", "reason"];
export const STEP_KINDS = ["step", "approval", "finish", "end"];
export const STEP_BODY_MAX_BYTES = 2048;
export const STEP_LABEL_MAX = 80;
export const STEP_SENTENCE_MAX = 240;

/**
 * Zero-width and bidi controls, the soft hyphen, the BOM and the tag block:
 * the characters a page uses to hide an instruction from a reader (A89, as
 * Nanobrowser v0.3 strips them).
 */
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

export function stripInvisible(text) {
  return String(text || "").replace(INVISIBLE, "");
}

/** NO URL WITH A QUERY OR A FRAGMENT IN THE LEDGER: "https://a.com/p?q=x#y" becomes "https://a.com/p". */
export function stripQueries(text) {
  // The sentence's own closing punctuation stays: "…/post?x=1." keeps its full stop.
  return String(text || "").replace(/\b(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, (match, base) => {
    const tail = /[.,;:!?)\]"']+$/.exec(match.slice(base.length));
    return base + (tail ? tail[0] : "");
  });
}

/** A label or a sentence as the ledger keeps it: visible, query-free, one line, bounded. */
export function ledgerText(text, max) {
  return stripQueries(stripInvisible(text)).replace(/\s+/g, " ").trim().slice(0, max);
}
