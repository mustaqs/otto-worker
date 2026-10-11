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

/** The row's retention after a terminal state. The instance's "7 days" in wrangler.toml and on create() is the same seven; the test asserts it. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
    ask: (spoken) => askUser({ step, env, task, entry }, spoken),
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
    const reason = message.startsWith("max_duration") ? "max_duration"
      : error && error.name === "TaskDeclined" ? "declined"
      : error && error.name === "TaskExpired" ? "timeout"
      : "step_failed";
    const state = reason === "declined" ? "cancelled" : reason === "timeout" ? "expired" : "failed";
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
    // BEST-EFFORT. The work is done; the ledger must not undo it.
    await recordStep(env, task, {
      name, started, ended: Date.now(), outcome: "ok",
      ...(out && out.cost ? out.cost : {}),
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
async function askUser({ step, env, task, entry }, spoken) {
  const askedAt = Date.now();
  const until = askedAt + durationMs(entry.approvalTimeout);
  await step.do("ask-write", { timeout: "1 minute" }, () =>
    markState(env, task, "awaiting_approval", { question: { spoken: String(spoken || "").slice(0, 240), askedAt, until } }));
  let event;
  try {
    event = await step.waitForEvent("ask-wait", { type: "approval", timeout: `${until - askedAt} ms` });
  } catch (error) {
    const expired = isTimeout(error);
    const word = expired ? "TaskExpired" : errorWord(error);
    console.error(`task ${task.type} step ask-wait failed: ${word}`);
    await recordStep(env, task, { name: "ask-wait", started: askedAt, ended: Date.now(), outcome: "failed", error: word });
    if (expired) throw Object.assign(new Error("timeout"), { name: "TaskExpired" });
    throw error;
  }
  const decision = event && event.payload && event.payload.decision === "approve" ? "approve" : "decline";
  await step.do("ask-read", { timeout: "1 minute" }, () =>
    markState(env, task, decision === "approve" ? "running" : "declined", { waitedMs: Date.now() - askedAt }));
  if (decision === "decline") throw Object.assign(new Error("declined"), { name: "TaskDeclined" });
  return decision;
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

/** `UPDATE tasks SET a = ?, b = ?, updated_at = ? WHERE id = ? AND account_id = ?` — one shape, so the test's stand-in parses one shape. */
async function updateRow(env, task, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  entries.push(["updated_at", Date.now()]);
  const sql = `UPDATE tasks SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ? AND account_id = ?`;
  await env.DB.prepare(sql).bind(...entries.map(([, v]) => v), task.id, task.accountId).run();
}

export async function deleteRow(env, task) {
  await env.DB.prepare(`DELETE FROM tasks WHERE id = ? AND account_id = ?`).bind(task.id, task.accountId).run();
}

export async function markState(env, task, state, { question, answer, waitedMs } = {}) {
  const fields = { state };
  if (question) fields.question = JSON.stringify(question);
  if (answer) fields.answer = JSON.stringify(answer);
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
 */
export async function recordStep(env, task, entry) {
  try {
    const row = await readRow(env, task);
    let steps = [];
    try { steps = JSON.parse((row && row.steps) || "[]"); } catch { steps = []; }
    if (!Array.isArray(steps)) steps = [];
    const index = steps.findIndex((s) => s && s.name === entry.name);
    if (index >= 0) steps[index] = entry; else steps.push(entry);
    await updateRow(env, task, { steps: JSON.stringify(steps) });
  } catch (error) {
    console.error(`task ledger not written for ${entry.name} (${error && error.name ? error.name : "error"})`);
  }
}

export async function finishTask(env, task, state, { result, reason } = {}) {
  const now = Date.now();
  const fields = { state, finished_at: now, expires_at: now + RETENTION_MS };
  if (result) fields.result = JSON.stringify(result);
  if (reason) fields.reason = reason;
  await updateRow(env, task, fields);
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
