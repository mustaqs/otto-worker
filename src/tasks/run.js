/**
 * Running a task (SPEC.md A82): the row is the truth, the Workflow instance
 * is the engine, and this file is the whole of what happens between them.
 *
 * NO PLATFORM IMPORT. `cloudflare:workers` and `cloudflare:workflows` are
 * imported by workflow.js alone, which hands `NonRetryableError` in, so
 * test.mjs can drive runTask with a fake step and a stand-in error class.
 *
 * THREE RULES THE BENCH HOLDS:
 *   - step.do is called from guardedStep (work), finalStep (the two finishing
 *     steps) and askUser (the two bookkeeping steps around a wait), and from
 *     nowhere else. guardedStep carries the max-duration comparison, so no
 *     work can run outside it.
 *   - waitForEvent is called from askUser alone, always with a timeout, and
 *     ONLY its timeout becomes `expired`; any other error is a failed step.
 *   - the ledger write is best-effort: a step whose work is done is never
 *     failed or retried because the bookkeeping failed.
 *
 * What is never logged: the request, the context, the document, a prompt, a
 * finding, the draft, the result, the question. Lines carry the type, the
 * state, the reason word, a step name and an error class.
 */
import { TYPES, TASK_VERSION } from "./registry.js";
import { anthropic, isPermanentModelError } from "./model.js";
import { summaryFromRows, tasksHeader, TERMINAL } from "./summary.js";

export { TASK_VERSION };

/** The row's retention after a terminal state. The instance's "3 days" in wrangler.toml and on create() is the same three (the Workers Free cap); the test asserts it. */
export const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------- run

export async function runTask({ event, step, env, NonRetryableError }) {
  const params = event && event.payload ? event.payload : {};
  const entry = TYPES[params.type];
  const task = {
    id: event.instanceId,
    type: params.type,
    accountId: params.accountId,
    createdAt: event.timestamp instanceof Date ? event.timestamp.getTime() : Number(event.timestamp) || Date.now(),
    input: params.input || {},
    maxDurationMs: entry ? entry.maxDurationMs : 0,
  };
  if (!entry) {
    console.error(`task of unknown type ${String(params.type).slice(0, 32)} ended failed: unknown_type`);
    await finalStep(step, "finish-failed", () => finishTask(env, task, "failed", { reason: "step_failed" }));
    return;
  }

  const ctx = {
    task,
    entry,
    step: (name, fn, config) => guardedStep({ step, env, task, NonRetryableError }, name, fn, config),
    ask: (spoken, key) => askUser({ step, env, task, entry }, spoken, key),
    // A89: the browser ledger's wait for "a step was posted", and the row it
    // then reads — only ever from inside a step, so a replay reads the cache.
    awaitStep: (i) => awaitStep({ step, env, task, entry }, i),
    row: () => readRow(env, task),
    model: async (request) => {
      try {
        return await anthropic(env, entry.model, request);
      } catch (error) {
        if (isPermanentModelError(error)) throw new NonRetryableError(error.message);
        throw error;
      }
    },
  };

  try {
    await ctx.step("start", async () => markState(env, task, "running"));
    const out = await entry.run(ctx);
    await finalStep(step, "finish", () => finishTask(env, task, "succeeded", { result: entry.render(out, task.input) }));
  } catch (error) {
    const message = String(error && error.message ? error.message : "");
    // The engine prefixes the message with the error's name ("NonRetryableError: max_duration before …"), so the word is searched, not the start.
    const reason = /\bmax_duration\b/.test(message) ? "max_duration"
      : error && error.name === "TaskDeclined" ? "declined"
      : error && error.name === "TaskExpired" ? "timeout"
      : error && error.name === "TaskIdle" ? "idle"
      : error && error.name === "TaskStepLimit" ? "step_limit"
      : "step_failed";
    const state = reason === "declined" ? "cancelled" : reason === "timeout" || reason === "idle" ? "expired" : "failed";
    // The reason word, never the words. The failed step named itself in the
    // ledger and the log before it threw (guardedStep, askUser): a property
    // set on the error inside step.do does not survive the engine's rethrow,
    // only the name and the message do — seen live on 2026-10-11.
    console.error(`task ${task.type} ended ${state}: ${reason}`);
    await finalStep(step, "finish-failed", () => finishTask(env, task, state, { reason }));
  }
}

/**
 * THE CALLER OF step.do FOR WORK. The clock check runs inside the step, so a
 * retry re-checks it, and NonRetryableError stops the retries. The approval
 * wait does not count: `waited_ms` on the row is subtracted.
 */
function guardedStep({ step, env, task, NonRetryableError }, name, fn, config = {}) {
  return step.do(name, {
    timeout: config.timeout || "5 minutes",
    retries: config.retries || { limit: 2, delay: "10 seconds", backoff: "exponential" },
  }, async () => {
    const row = await readRow(env, task);
    const elapsed = Date.now() - task.createdAt - (Number(row && row.waited_ms) || 0);
    const started = Date.now();
    let out;
    try {
      if (elapsed > task.maxDurationMs) throw new NonRetryableError(`max_duration before ${name} at ${elapsed}ms`);
      out = await fn();
    } catch (error) {
      // THE FAILED ENTRY IS WRITTEN HERE, inside the step, best-effort, before
      // the rethrow: the engine hands the caller a fresh error with only the
      // name and the message, so nothing attached here would reach runTask.
      // A retry that then succeeds replaces this entry under the same name.
      const word = errorWord(error);
      console.error(`task ${task.type} step ${name} failed: ${word}`);
      await recordStep(env, task, { name, started, ended: Date.now(), outcome: "failed", error: word });
      throw error;
    }
    // BEST-EFFORT. The work is done; the ledger must not undo it. The label
    // and the plan's queries are the only words a step hands the ledger
    // (A84): the tab names steps from them, the feed never reads an output.
    // A bookkeeping step (the browser ledger's reads, A89) writes no entry.
    if (config.record === false) return out;
    await recordStep(env, task, {
      name, started, ended: Date.now(), outcome: "ok",
      ...(out && out.cost ? out.cost : {}),
      ...(out && typeof out.label === "string" && out.label ? { label: out.label.slice(0, 80) } : {}),
      ...(out && Array.isArray(out.queries) ? { queries: out.queries.slice(0, 20).map((q) => String(q).slice(0, 80)) } : {}),
    });
    return out;
  });
}

/** THE OTHER CALLER OF step.do, for the two finishing steps: no clock check, so a task that ran out of time can still write that it did. */
function finalStep(step, name, fn) {
  return step.do(name, { timeout: "1 minute", retries: { limit: 1, delay: "5 seconds", backoff: "constant" } }, fn);
}

/**
 * THE ONLY CALLER OF waitForEvent. Writes the question, waits the type's FULL
 * approval timeout, records how long it waited so the clock forgives it, and
 * maps only the timeout to `expired`.
 */
async function askUser({ step, env, task, entry }, spoken, key) {
  // ONE SET OF STEP NAMES PER QUESTION. Research asks at most once and keeps
  // its names; a browser task may ask before each act, keyed by its step (A89).
  const suffix = key ? `-${key}` : "";
  // THE WAIT'S START IS A STEP'S OUTPUT, never a local. After a hibernated
  // wait the engine replays run() from the top and only step outputs survive:
  // a `Date.now()` taken here would be the replay's time, the wait would be
  // recorded as milliseconds, and the clock would not forgive it — the live
  // run of 2026-10-11 recorded waited_ms 64 for a 34-minute wait and ran out.
  const asked = await step.do(`ask-write${suffix}`, { timeout: "1 minute" }, async () => {
    const askedAt = Date.now();
    const until = askedAt + durationMs(entry.approvalTimeout);
    await markState(env, task, "awaiting_approval", { question: { spoken: String(spoken || "").slice(0, 240), askedAt, until } });
    return { askedAt, until };
  });
  let event;
  try {
    event = await step.waitForEvent(`ask-wait${suffix}`, { type: "approval", timeout: `${asked.until - asked.askedAt} ms` });
  } catch (error) {
    const expired = isTimeout(error);
    const word = expired ? "TaskExpired" : errorWord(error);
    console.error(`task ${task.type} step ask-wait failed: ${word}`);
    await recordStep(env, task, { name: `ask-wait${suffix}`, started: asked.askedAt, ended: Date.now(), outcome: "failed", error: word });
    if (expired) throw Object.assign(new Error("timeout"), { name: "TaskExpired" });
    throw error;
  }
  const decision = event && event.payload && event.payload.decision === "approve" ? "approve" : "decline";
  await step.do(`ask-read${suffix}`, { timeout: "1 minute" }, () =>
    markState(env, task, decision === "approve" ? "running" : "declined", { waitedMs: Date.now() - asked.askedAt }));
  if (decision === "decline") throw Object.assign(new Error("declined"), { name: "TaskDeclined" });
  return decision;
}

/**
 * THE OTHER CALLER OF waitForEvent (A89): the browser ledger's wait for "a
 * step was posted", with the type's idle limit as its timeout. Only that
 * timeout becomes `expired` (reason `idle`): "Your Mac went to sleep or Otto
 * quit, so I stopped." Any other error is a failed step.
 */
async function awaitStep({ step, env, task, entry }, i) {
  try {
    return await step.waitForEvent(`step-wait-${i}`, { type: "browser-step", timeout: entry.idleTimeout });
  } catch (error) {
    const idle = isTimeout(error);
    console.error(`task ${task.type} step step-wait-${i} failed: ${idle ? "TaskIdle" : errorWord(error)}`);
    if (idle) throw Object.assign(new Error("idle"), { name: "TaskIdle" });
    throw error;
  }
}

/**
 * The platform does not name its timeout error in the docs read on
 * 2026-10-10. The name is checked first and the message second; the first
 * live timeout pins which one fires (its class is logged beside the ask-wait step).
 */
export function isTimeout(error) {
  if (!error) return false;
  if (/timeout/i.test(String(error.name || ""))) return true;
  return /\btime(d)?[ -]?out\b/i.test(String(error.message || ""));
}

/** "24 hours" → 86,400,000. Accepts ms as a number or a string of the units Workflows accepts. */
export function durationMs(value) {
  if (typeof value === "number") return value;
  const match = /^\s*(\d+)\s*(ms|millisecond|second|minute|hour|day|week)s?\s*$/i.exec(String(value || ""));
  if (!match) return 24 * 60 * 60 * 1000;
  const n = Number(match[1]);
  switch (match[2].toLowerCase()) {
    case "ms": case "millisecond": return n;
    case "second": return n * 1000;
    case "minute": return n * 60 * 1000;
    case "hour": return n * 60 * 60 * 1000;
    case "day": return n * 24 * 60 * 60 * 1000;
    case "week": return n * 7 * 24 * 60 * 60 * 1000;
    default: return n;
  }
}

const errorWord = (error) => {
  const message = String(error && error.message ? error.message : "");
  if (/^model_(http_\d{3}|unreachable|not_provisioned)$/.test(message)) return message;
  return error && error.name ? String(error.name) : "error";
};

// ------------------------------------------------------------------- D1

/** The row, or null. Every read names the account: another account's id is not found. */
export async function readRow(env, task) {
  return env.DB.prepare(`SELECT * FROM tasks WHERE id = ? AND account_id = ?`)
    .bind(task.id, task.accountId).first();
}

export async function insertRow(env, row) {
  await env.DB.prepare(
    `INSERT INTO tasks (id, account_id, type, state, input, steps, created_at, updated_at)
     VALUES (?, ?, ?, 'created', ?, '[]', ?, ?)`
  ).bind(row.id, row.accountId, row.type, JSON.stringify(row.input), row.createdAt, row.createdAt).run();
}

/**
 * A89 §11: one model call of a browser task, counted on its row in ONE
 * statement that is also the check. It lands only for the account's own
 * browser task, alive and not waiting for a yes, under the call bound; the
 * row comes back with the count, so the caller learns the steps without a
 * second read. Null means refused, and the caller reads the row to say why.
 */
export async function countCall(env, task, max) {
  return env.DB.prepare(
    `UPDATE tasks SET calls = calls + 1 WHERE id = ? AND account_id = ? AND type = 'browser'
     AND state IN ('created', 'running', 'approved') AND calls < ?
     RETURNING steps, created_at, waited_ms, calls`
  ).bind(task.id, task.accountId, max).first();
}

/** `UPDATE tasks SET a = ?, b = ?, updated_at = ? WHERE id = ? AND account_id = ?` — one shape, so the test's stand-in parses one shape. */
async function updateRow(env, task, fields, { unlessFinished = false } = {}) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  entries.push(["updated_at", Date.now()]);
  // A FINISHED ROW STAYS AS IT FINISHED: the first final state wins.
  const guard = unlessFinished ? " AND state NOT IN ('succeeded', 'failed', 'cancelled', 'expired')" : "";
  const sql = `UPDATE tasks SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ? AND account_id = ?${guard}`;
  await env.DB.prepare(sql).bind(...entries.map(([, v]) => v), task.id, task.accountId).run();
}

export async function deleteRow(env, task) {
  await env.DB.prepare(`DELETE FROM tasks WHERE id = ? AND account_id = ?`).bind(task.id, task.accountId).run();
}

export async function markState(env, task, state, { question, answer, waitedMs, seen } = {}) {
  const fields = { state };
  if (question) fields.question = JSON.stringify(question);
  if (answer) fields.answer = JSON.stringify(answer);
  // A decline is the user's answer: the row it ends is seen before the
  // Workflow finishes it, so finishTask's own UPDATE leaves seen_at alone.
  if (seen) fields.seen_at = Date.now();
  if (waitedMs) {
    const row = await readRow(env, task);
    fields.waited_ms = (Number(row && row.waited_ms) || 0) + Math.max(0, Math.round(waitedMs));
  }
  await updateRow(env, task, fields);
  await writeSummary(env, task.accountId);
}

/**
 * One ledger entry per step name; a retry replaces its own entry. BEST-EFFORT:
 * logged by class, never thrown.
 *
 * COMPARE-AND-SET, since A89 gave the ledger a second writer: the step route
 * appends while the Workflow records its own steps, and a plain
 * read-modify-write would drop whichever wrote first. The write lands only
 * if the list is still what was read; a lost race reads again, three times.
 */
export async function recordStep(env, task, entry) {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await readRow(env, task);
      const steps = parseSteps(row);
      const index = steps.findIndex((s) => s && s.name === entry.name);
      if (index >= 0) steps[index] = entry; else steps.push(entry);
      if (await casSteps(env, task, row, steps)) return;
    }
    console.error(`task ledger not written for ${entry.name} (LedgerConflict)`);
  } catch (error) {
    console.error(`task ledger not written for ${entry.name} (${error && error.name ? error.name : "error"})`);
  }
}

/**
 * The step route's append (A89): THROWS, unlike recordStep — a step the Mac
 * posted and the relay did not keep must be answered as an error, and a lost
 * race (the same step posted twice) as LedgerConflict.
 */
export async function appendStep(env, task, row, entry) {
  const steps = parseSteps(row);
  steps.push(entry);
  if (!(await casSteps(env, task, row, steps))) throw Object.assign(new Error("ledger moved"), { name: "LedgerConflict" });
}

function parseSteps(row) {
  let steps = [];
  try { steps = JSON.parse((row && row.steps) || "[]"); } catch { steps = []; }
  return Array.isArray(steps) ? steps : [];
}

/** `UPDATE … WHERE id = ? AND account_id = ? AND steps = ?`: true when it landed. */
async function casSteps(env, task, row, steps) {
  const result = await env.DB.prepare(
    `UPDATE tasks SET steps = ?, updated_at = ? WHERE id = ? AND account_id = ? AND steps = ?`
  ).bind(JSON.stringify(steps), Date.now(), task.id, task.accountId, (row && row.steps) || "[]").run();
  return !(result && result.meta && Number(result.meta.changes) === 0);
}

export async function finishTask(env, task, state, { result, reason, seen } = {}) {
  const now = Date.now();
  const fields = { state, finished_at: now, expires_at: now + RETENTION_MS };
  if (result) fields.result = JSON.stringify(result);
  if (reason) fields.reason = reason;
  // THE USER'S OWN CANCEL IS ALREADY SEEN. A row the user ended knowingly
  // must not come back on the next chord as "The research was cancelled."
  if (seen) fields.seen_at = now;
  // THE FIRST ENDING IS THE ENDING (found 2026-10-28): the user closed
  // Otto's tab, the Mac posted the end, and a step posted a moment earlier
  // then failed to reach the terminated instance and wrote "failed" over
  // the user's own cancel. Whatever finishes a row first is what it says.
  await updateRow(env, task, fields, { unlessFinished: true });
  await writeSummary(env, task.accountId);
}

/**
 * The account's rows, newest first. RETENTION IS A COMPARISON HERE, in the
 * shape integrationRows uses: a terminal row past expires_at is deleted, and
 * its instance with it, before the rows are returned. No cron.
 */
export async function taskRows(env, accountId, now = Date.now()) {
  const result = await env.DB.prepare(
    `SELECT * FROM tasks WHERE account_id = ? ORDER BY updated_at DESC`
  ).bind(accountId).all();
  const rows = (result && result.results) || [];
  const kept = [];
  for (const row of rows) {
    if (TERMINAL.has(row.state) && Number(row.expires_at) && Number(row.expires_at) < now) {
      await deleteRow(env, { id: row.id, accountId });
      await deleteInstance(env, row.id);
      console.log(`task row expired and removed (${row.type})`);
    } else {
      kept.push(row);
    }
  }
  return kept;
}

/** The KV copy of the account's task state, rewritten whole. */
export async function writeSummary(env, accountId) {
  const rows = await taskRows(env, accountId);
  const summary = summaryFromRows(rows);
  await env.OTTO.put(`tasks:${accountId}`, JSON.stringify(summary));
  return summary;
}

/** The header for a reply that already touched D1: exact, from the rows. */
export async function tasksHeaderFor(env, accountId) {
  const rows = await taskRows(env, accountId);
  return tasksHeader(summaryFromRows(rows));
}

// -------------------------------------------------------------- instance

/** Best effort: an instance already gone, or already finished, is not an error the user sees. */
export async function deleteInstance(env, id) {
  if (!env.TASKS) return false;
  try {
    const instance = await env.TASKS.get(id);
    await instance.delete();
    return true;
  } catch (error) {
    console.log(`task instance not deleted (${error && error.name ? error.name : "error"})`);
    return false;
  }
}

export async function terminateInstance(env, id) {
  if (!env.TASKS) return false;
  try {
    const instance = await env.TASKS.get(id);
    await instance.terminate();
    return true;
  } catch (error) {
    console.log(`task instance not terminated (${error && error.name ? error.name : "error"})`);
    return false;
  }
}
