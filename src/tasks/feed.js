/**
 * The task feed (SPEC.md A84): the account's tasks as server-sent events,
 * fed by the platform's own event log — a subscription on each unfinished
 * Workflow instance — projected to what the tab draws. NEVER a finding,
 * never the write-up, never a search result: a step's `output` is not read,
 * and a row's `result` is parsed only for the spoken sentence and the note's
 * title. The ledger (`steps` on the row) names each step and, since this
 * file, labels it, so the snapshot needs no instance read.
 *
 * Frames, each `event: <name>\ndata: <json>\n\n`:
 *   snapshot  { at, tasks: [projection] }             once, on connect
 *   task      projection                              a row changed (state, finish, seen)
 *   step      { task, name, label, outcome, started?, ended?, eventId }
 *   gone      { id }                                  a row deleted elsewhere
 *   : ping                                            every 15 s while idle
 *
 * PURE OF THE PLATFORM: reaches it only through env.TASKS (duck-typed; the
 * tests script `subscribe()`), D1 through run.js. One timer, created when
 * the stream starts and cleared when it ends — by the client's disconnect
 * or the stream's cancel, whichever arrives first.
 */
import { TERMINAL } from "./summary.js";
import { taskRows, readRow } from "./run.js";
import { titleOf } from "./title.js";

export const SUBJECT_MAX = 120;
export const LABEL_MAX = 80;
export const PING_MS = 15_000;
/** Every second ping, the rows are re-read to notice a task started elsewhere. */
export const REREAD_EVERY = 2;
/** The steps a user sees. start, ask-write, ask-read, finish and finish-failed are bookkeeping. */
export const SHOWN = /^(plan|draft|search-\d+|step-\d+)$/;

const parse = (json) => { try { return json ? JSON.parse(json) : null; } catch { return null; } };
const cut = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

/** The plan step's queries from the ledger, cut, or []. */
export function queriesOf(row) {
  const steps = parse(row && row.steps);
  const plan = Array.isArray(steps) ? steps.find((s) => s && s.name === "plan") : null;
  return plan && Array.isArray(plan.queries) ? plan.queries.map((q) => cut(q, LABEL_MAX)) : [];
}

/** The label for a step: the ledger's, else derived from the name and the plan's queries. */
export function labelFor(name, queries, entry) {
  if (entry && typeof entry.label === "string" && entry.label) return cut(entry.label, LABEL_MAX);
  const search = /^search-(\d+)$/.exec(name);
  if (search) return queries[Number(search[1]) - 1] || `Search ${search[1]}`;
  if (name === "plan") return queries.length ? `Planned ${queries.length} searches` : "Planning";
  if (name === "draft") return "Writing it up";
  return name;
}

/** The row as the tab sees it. Reads `result` once, for two short strings. */
export function projectRow(row) {
  const input = parse(row.input) || {};
  const question = parse(row.question);
  const result = row.result ? parse(row.result) : null;
  const queries = queriesOf(row);
  const ledger = parse(row.steps);
  const steps = (Array.isArray(ledger) ? ledger : [])
    .filter((s) => s && typeof s.name === "string" && SHOWN.test(s.name))
    .map((s) => ({
      name: s.name,
      label: labelFor(s.name, queries, s),
      outcome: s.outcome === "failed" ? "failed" : "ok",
      started: Number(s.started) || 0,
      ...(Number(s.ended) ? { ended: Number(s.ended) } : {}),
    }));
  const notes = result && result.deliver && result.deliver.notes;
  return {
    id: row.id,
    type: row.type,
    state: row.state,
    ...(row.reason ? { reason: row.reason } : {}),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    ...(row.finished_at ? { finishedAt: Number(row.finished_at) } : {}),
    seen: row.seen_at != null,
    subject: cut(input.request, SUBJECT_MAX),
    // A browser task's mode and the site it started on (A89): the approval
    // card's source line is "Chrome · <host>" (A90).
    ...(row.type === "browser" && typeof input.host === "string" ? { site: cut(input.host, 253) } : {}),
    ...(row.type === "browser" && typeof input.mode === "string" ? { mode: input.mode } : {}),
    // The name the task goes by everywhere (A91); the request cut at a word
    // boundary for a task created before titles.
    title: titleOf(input),
    ...(question && question.spoken ? { question: { spoken: question.spoken, until: Number(question.until) || 0, ...(question.kind === "turn" ? { kind: "turn" } : {}) } } : {}),
    ...(result && result.spoken ? { spoken: result.spoken } : {}),
    ...(notes && typeof notes.title === "string" && notes.title ? { noteTitle: notes.title } : {}),
    steps,
  };
}

/** The light read behind the periodic re-read: ids and states, no blobs. */
async function lightRows(env, accountId) {
  const result = await env.DB.prepare(`SELECT id, state, updated_at FROM tasks WHERE account_id = ?`).bind(accountId).all();
  return (result && result.results) || [];
}

/**
 * The stream. `cursors` is `{ [taskId]: lastEventId }` from a reconnecting
 * client; a subscription resumes after that id and replays nothing older.
 * Without one the platform replays the instance's retained events, which
 * reach the client as `step` frames right after the snapshot — the same
 * steps the ledger already named, merged by name, plus the one in flight.
 */
export function openFeed({ env, accountId, cursors = {}, signal, now = Date.now }) {
  const encoder = new TextEncoder();
  let controller = null;
  let closed = false;
  let timer = null;
  let ticks = 0;
  const subscriptions = new Map();   // id → dispose
  const queries = new Map();         // id → the plan's queries
  const known = new Map();           // id → { state, updatedAt }
  const startedAt = new Map();       // `${id}/${step}` → the running frame's time

  const write = (text) => {
    if (closed) return;
    try { controller.enqueue(encoder.encode(text)); } catch { close(); }
  };
  const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  function close() {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    for (const dispose of subscriptions.values()) { try { dispose(); } catch { /* already gone */ } }
    subscriptions.clear();
    try { controller.close(); } catch { /* the client is gone */ }
  }

  const remember = (projection) => {
    known.set(projection.id, { state: projection.state, updatedAt: projection.updatedAt });
  };

  async function emitTask(id) {
    let row;
    try { row = await readRow(env, { id, accountId }); } catch (error) {
      console.error(`task feed row unreadable (${error && error.name ? error.name : "error"})`);
      return null;
    }
    if (!row) { known.delete(id); send("gone", { id }); return null; }
    const projection = projectRow(row);
    queries.set(id, queriesOf(row));
    remember(projection);
    send("task", projection);
    return projection;
  }

  async function refreshQueries(id) {
    try {
      const row = await readRow(env, { id, accountId });
      if (row) queries.set(id, queriesOf(row));
    } catch (error) {
      console.error(`task feed row unreadable (${error && error.name ? error.name : "error"})`);
    }
  }

  async function handle(id, event) {
    const name = event && typeof event.stepName === "string" ? event.stepName : "";
    const at = Number(event && event.timestamp) || now();
    switch (event && event.type) {
      case "step_started":
        if (!SHOWN.test(name)) return;
        startedAt.set(`${id}/${name}`, at);
        send("step", { task: id, name, label: labelFor(name, queries.get(id) || []), outcome: "running", started: at, eventId: event.eventId });
        return;
      case "step_completed":
      case "step_errored": {
        if (name === "plan") await refreshQueries(id);
        if (!SHOWN.test(name)) return;
        const started = startedAt.get(`${id}/${name}`);
        startedAt.delete(`${id}/${name}`);
        send("step", {
          task: id, name, label: labelFor(name, queries.get(id) || []),
          outcome: event.type === "step_errored" ? "failed" : "ok",
          ...(started ? { started } : {}), ended: at, eventId: event.eventId,
        });
        return;
      }
      case "wait_started":
      case "wait_completed":
      case "wait_timed_out":
      case "workflow_completed":
      case "workflow_errored":
      case "workflow_terminated":
        await emitTask(id);
        return;
      default:
        return;   // attempts, sleeps, rollbacks, lifecycle noise
    }
  }

  async function follow(id, cursor) {
    if (closed || !env.TASKS || subscriptions.has(id)) return;
    let subscription;
    try {
      const instance = await env.TASKS.get(id);
      subscription = await instance.subscribe(Number.isInteger(cursor) ? { cursor } : undefined);
    } catch (error) {
      console.error(`task feed could not subscribe (${error && error.name ? error.name : "error"})`);
      return;
    }
    const dispose = () => { if (typeof subscription[Symbol.dispose] === "function") subscription[Symbol.dispose](); };
    if (closed) { try { dispose(); } catch { /* fine */ } return; }
    subscriptions.set(id, dispose);
    try {
      while (!closed) {
        let result;
        try { result = await subscription.next(); } catch (error) {
          if (!closed) console.error(`task feed subscription ended (${error && error.name ? error.name : "error"})`);
          break;
        }
        if (!result || result.done) break;
        await handle(id, result.value);
      }
    } finally {
      try { dispose(); } catch { /* fine */ }
      subscriptions.delete(id);
    }
  }

  async function reread() {
    let rows;
    try { rows = await lightRows(env, accountId); } catch (error) {
      console.error(`task feed rows unreadable (${error && error.name ? error.name : "error"})`);
      return;
    }
    const seen = new Set();
    for (const row of rows) {
      seen.add(row.id);
      const before = known.get(row.id);
      if (!before) {
        const projection = await emitTask(row.id);
        if (projection && !TERMINAL.has(projection.state)) follow(row.id).catch(() => {});
      } else if (before.updatedAt !== (Number(row.updated_at) || 0) || before.state !== row.state) {
        await emitTask(row.id);
      }
    }
    for (const id of [...known.keys()]) if (!seen.has(id)) { known.delete(id); send("gone", { id }); }
  }

  async function begin() {
    let rows;
    try { rows = await taskRows(env, accountId); } catch (error) {
      console.error(`task feed rows unreadable (${error && error.name ? error.name : "error"})`);
      close();
      return;
    }
    const projections = rows.map(projectRow);
    for (const row of rows) queries.set(row.id, queriesOf(row));
    for (const projection of projections) remember(projection);
    send("snapshot", { at: now(), tasks: projections });
    for (const projection of projections) {
      if (!TERMINAL.has(projection.state)) follow(projection.id, cursors[projection.id]).catch(() => {});
    }
    timer = setInterval(() => {
      if (closed) return;
      ticks += 1;
      write(": ping\n\n");
      if (ticks % REREAD_EVERY === 0) reread().catch(() => {});
    }, PING_MS);
  }

  const stream = new ReadableStream({
    start(c) {
      controller = c;
      begin().catch((error) => {
        console.error(`task feed failed to start (${error && error.name ? error.name : "error"})`);
        close();
      });
    },
    cancel() { close(); },
  });
  if (signal) {
    if (signal.aborted) close();
    else signal.addEventListener("abort", close, { once: true });
  }
  return stream;
}
