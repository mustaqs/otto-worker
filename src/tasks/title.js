/**
 * A task's short title (Otto SPEC A91): the name a task goes by everywhere it
 * is named — the spoken sentences, the approval card, the Ottobots tab, the
 * notifications. PURE: no bindings, no logging.
 *
 * The model writes it with create_task, at most six words ("GMT watches under
 * $5,000"), and it is stored in the row's input beside the request. A task
 * created before titles existed has none, and is named by its request cut
 * cleanly at a word boundary instead — never mid-word, as the first manual run
 * heard ("the research on Research watch options … a GMT (d").
 */
export const TITLE_MAX_WORDS = 6;
export const TITLE_MAX_CHARS = 60;

const words = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean) : []);
const tidy = (text) => text.replace(/[\s.,;:!?(\[{\-–—]+$/u, "");

/** The model's title, cleaned and bounded; "" when there is none. */
export function cleanTitle(value) {
  const all = words(value);
  const kept = all.slice(0, TITLE_MAX_WORDS);
  while (kept.length > 1 && kept.join(" ").length > TITLE_MAX_CHARS) kept.pop();
  const text = tidy(kept.join(" ").slice(0, TITLE_MAX_CHARS));
  return text && kept.length < all.length ? `${text}…` : text;
}

/** For a task without a title: the request's first clause, cut at a word boundary. */
export function fallbackTitle(request) {
  const first = typeof request === "string" ? request.split(/[.;:?!\n(]/)[0] : "";
  return cleanTitle(first) || cleanTitle(request);
}

/** The name a stored task goes by. */
export function titleOf(input) {
  return cleanTitle(input && input.title) || fallbackTitle(input && input.request) || "Task";
}
