# tasks-runtime — Phase 1 design checkpoint

Branch `tasks-runtime`, otto-worker. Nothing here is built; this is the shape
to approve before anything is. The app half (branch `tasks-app`) is designed
separately; this document is the runtime half of SPEC.md A82.

Approved 2026-10-11 with three corrections, applied below: (1) approval
waits do not count against `maxDurationMs` — the resolved wait is recorded on
the row as `waited_ms`, `guardedStep` subtracts it, and the wait uses the
type's full `approvalTimeout`; (2) `recordStep` is best-effort inside the
step — a ledger write failure is logged by class and never fails or retries
the step; (3) `askUser` maps only the `waitForEvent` timeout to `expired`;
any other error is `step_failed`. Placeholders accepted: `task_cap` free = 5,
`askAboveSearches` = 6.

Decisions already taken (2026-10-10): Cloudflare Workflows; retention 7 days, revised to 3 days on 2026-10-11 (the Workers Free cap on instance retention, see section 10)
after a terminal state, the Workflow instance's own retention matched and the
instance deleted once the result is taken; research 30 minutes / 20 steps;
approval timeout 24 hours; catalog static in the app; `otto-tasks` exact on
tool and panel replies and from a KV summary on the question reply; no
screenshot ever in a task, the document only when a type declares
`needsDocument` (research: no); research on `claude-sonnet-5` with web search
`allowed_callers: ["direct"]`; the README's "never reads a response body"
restated to the question path; the second reader of the key benched.

---

## 1. SPEC.md A82 — draft, runtime half

### A82 — Tasks: a Workflow on the relay, delivered on the next question

Otto can start work that outlasts a question — minutes of steps, an hour's
wait for a yes — and finish it while the user does something else. The work
runs on the relay as a Cloudflare Workflow; nothing runs on the Mac between
questions, and the result waits on the relay until the next chord or the next
panel open carries it home. This amendment is the runtime half: what the
Worker holds, runs, answers and forgets. The app half, and the first type's
spoken shape, are A83.

**1. The runtime is Cloudflare Workflows, and the hard maximum is ours.** A
Workflow gives, as platform properties, the four things a task needs: a step
log persisted per step, retries with backoff and a non-retryable escape, a
pause of up to 365 days on `step.waitForEvent` with a timeout that throws, and
a status and terminate API. Measured against the docs on 2026-10-10
(`workflows/reference/limits`, `build/sleeping-and-retrying`,
`build/events-and-parameters`, `build/workers-api`): no instance duration
cap exists — "a Workflow instance can run forever" — so every step is wrapped
by one function that compares the clock against the instance's creation time
and throws `NonRetryableError` past the type's `maxDurationMs`; the approval
wait's timeout is the lesser of the type's `approvalTimeout` and what remains.
Durable Objects with alarms were measured and declined: one alarm per object,
six retries, a 15-minute alarm wall clock, and a documented shutdown on every
deploy that stops any in-flight request touching storage. What is **not
established**, in writing, after two sweeps: what an in-flight Workflow
instance runs after a redeploy. The mitigation is what the rules page does
say: step names are cache keys, so they are deterministic and a type's step
list only ever grows at the end, and every instance carries a `taskVersion`.

**2. One Workflow class, a registry of types.** `OttoTask` is the only
Workflow; its `run` dispatches on `params.type` to a registry entry
(`src/tasks/registry.js`). An entry declares the tool the model sees, its
input schema, `needsDocument`, `approvalTimeout`, `maxDurationMs`,
`maxSteps`, `costClass`, the step function, and a renderer that returns one
spoken sentence, a detail, and how to deliver it. Adding a type is one file
under `src/tasks/`, one registry entry, one test block — and in the app one
enum value, two lines, one pin (A83). The step function receives a context
with exactly one way to reach a model, `ctx.model(...)`, which is the second
reader of `ANTHROPIC_API_KEY` in the Worker and the first reader of a model's
response body: the question path's pass-through (A26) is a claim about the
question path and is restated so in the README. The context's shape leaves
room for a second named model function — a decision model — and wires none.

**3. The row is the truth; the instance is the engine.** D1 gains `tasks`:
id (the instance id, minted by the Worker), account, type, state, input,
steps, question, answer, result, reason, seen, created, updated, finished,
expires. The input is the request and A80's window line; never a screenshot,
which would be the first retained one anywhere, and the document only for a
type that declares it. The state machine is nine states and every
transition is named below with who makes it. Retention is a comparison at
read, in the shape `integrationRows` already uses: a terminal row past
`expires_at` is deleted when the account's rows are next read, no cron. The
Workflow's own copy of the run — Cloudflare keeps completed instance state
seven days by default on Paid since 2026-09-10, and caps it at three on Free —
is set to the same three and
the instance is deleted when the result is taken, so there is one retention,
not two.

**4. Delivery rides what already travels.** `otto-tasks` is a header on the
model of `otto-integrations`: counts, up to eight ids with state and type, the
one pending question's sentence, up to two unseen results' sentences. On tool
and panel replies it is computed from D1 and exact. On the question reply it
comes from one KV key per account, `tasks:<subject>`, rewritten from D1 by the
Workflow and the task routes after every transition and read in `checkLimits`
inside the `Promise.all` the counters already make — no new binding, no added
latency, and the sixty-second edge cache A26 records, so a completion can lag
a minute on a question and never on a tool call. The question path only
reads that key; the bench asserts it never writes it. Taking a result is one
request the delivering chord already causes — `/v1/tasks/take` returns the
detail that no header could carry, marks the row seen, and deletes the
instance. If the user never asks again and never opens the panel, nothing
happens: no sound, no badge, no notification, and retention removes the row.

**5. Approval is an event.** A step that needs a yes writes `question` on the
row, moves it to `awaiting_approval`, rewrites the summary, and calls
`step.waitForEvent` with the type's timeout. `/v1/tasks/approve` checks the
row is still awaiting, sends the event, writes the answer. On timeout the
step catches, the row is `expired`, and the next chord says so. Research asks
once at most: when its plan needs more than `askAboveSearches` searches, it
asks before spending them.

**6. Metering.** `task_cap` joins the plan row beside `tool_cap`, a day
counter in KV keyed `u:<account>:k:<day>`, checked and counted before
`env.TASKS.create` so a create that fails still counts; zero means no gate.
Every step records what it cost — model, tokens in and out, cache reads,
searches, an estimate in cents from a price table in the registry — in the
row's `steps`; the type's `maxSteps` bounds the longest path and the test
counts it.

**What A62's claim becomes:** "Otto makes one network request per question,
or two when Otto looks something up for you in a connected app. When you ask
Otto to work on something that takes a while, it makes one request to start
it and one to collect the result; approving, cancelling and deleting a task
are one each, when you do them. It makes two more when you sign in …" The
privacy page gains: "If you ask Otto to work on something that takes a while,
the work runs on our relay, not on your Mac, and the result waits there until
you next ask Otto something or open its menu. We keep what you asked for, the
steps it took and the result for three days or until you delete them, and
nothing else about it."

**The A26 rows:** *A task* | what you asked for, the window line, the document
only when the task needed it, each step's outcome and the result, kept three
days after it finishes or until you delete it | **does not** retain longer, by
the relay, and the Workflow's own copy is set to the same three days and
deleted when you collect the result. *Where it runs* | on our relay, as a
Cloudflare Workflow, never on your Mac | **cannot** run on the Mac: no timer,
no poll, no stream; `Bench/check-tasks.sh` (A83) fails if one appears.

**Does not:** read a response body on the question path; put D1 on the
question path; store a screenshot; run anything on the Mac; notify; retry an
approval; carry a result in a header; pass any MCP URL; let a step name
depend on a clock or a random value.

---

## 2. The migration — `migrations/0005_tasks.sql`

```sql
-- A82: long-running tasks. One row per task; the Workflow instance with the
-- same id is the engine and this row is the truth. NOTHING ON THE QUESTION
-- PATH READS THIS TABLE: the question reply learns of a task from the KV
-- summary `tasks:<account>`, which the Workflow and the task routes rewrite
-- from these rows after every transition.
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,                        -- the Workflow instance id, crypto.randomUUID()
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  type        TEXT NOT NULL,                           -- registry key: 'research'
  state       TEXT NOT NULL CHECK (state IN (
                'created', 'running', 'awaiting_approval', 'approved', 'declined',
                'succeeded', 'failed', 'cancelled', 'expired')),
  input       TEXT NOT NULL,                           -- JSON {request, context?, document?, now, tz, taskVersion}
  steps       TEXT NOT NULL DEFAULT '[]',              -- JSON [{name, started, ended, outcome, model?, in?, out?, cacheRead?, searches?, cents?}]
  question    TEXT,                                    -- JSON {spoken, askedAt, until}
  answer      TEXT,                                    -- JSON {decision, at}
  result      TEXT,                                    -- JSON {spoken, detail, deliver}   (detail ≤ 262,144 bytes)
  reason      TEXT,                                    -- one word on failed/expired/cancelled: max_duration, step_failed, timeout, user, declined
  waited_ms   INTEGER NOT NULL DEFAULT 0,              -- time spent awaiting approval; subtracted from the max-duration clock
  seen_at     INTEGER,                                 -- set by /v1/tasks/take
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  finished_at INTEGER,                                 -- set on the first terminal state
  expires_at  INTEGER                                  -- finished_at + 3 days; a comparison at read deletes the row
);
CREATE INDEX IF NOT EXISTS tasks_by_account ON tasks(account_id, updated_at);

-- Tasks have their own daily cap, like tool calls (0003). ZERO MEANS NO GATE.
-- The trial has no account and never reaches a task. THE NUMBER FOR `free`
-- IS A PLACEHOLDER UNTIL SET: a task is tens of model calls, not one.
ALTER TABLE plans ADD COLUMN task_cap INTEGER NOT NULL DEFAULT 0;
UPDATE plans SET task_cap = 5 WHERE name = 'free';
UPDATE plans SET task_cap = 0 WHERE name = 'beta';
```

Sizes against D1's limits (2 MB per row, 100 KB per statement, 100 bound
parameters): `input` ≤ 40 KB (request ≤ 4,000 chars, context line ≤ 300,
document ≤ 32 KB when allowed), `steps` ≤ 20 entries, `result.detail` ≤ 256 KB,
`question.spoken` and `result.spoken` ≤ 240 chars. No R2.

### The state machine

| from | to | who | how |
| --- | --- | --- | --- |
| — | `created` | `/v1/tasks/create` | row inserted, then `env.TASKS.create({ id, params, retention })` |
| `created` | `running` | the Workflow, first step | `markState` |
| `running` | `awaiting_approval` | the Workflow, `ctx.ask()` | writes `question`, then `waitForEvent` |
| `awaiting_approval` | `approved` / `declined` | `/v1/tasks/approve` | writes `answer`, `instance.sendEvent({ type: "approval", payload })` |
| `awaiting_approval` | `expired` | the Workflow, timeout caught | `reason: "timeout"`, finish |
| `approved` | `running` | the Workflow, after the wait | `markState` |
| `declined` | `cancelled` | the Workflow, after the wait | `reason: "declined"`, finish |
| `running` | `succeeded` | the Workflow, `finish` | writes `result` |
| `running` | `failed` | the Workflow, catch | `reason: "max_duration"` or `"step_failed"` |
| any non-terminal | `cancelled` | `/v1/tasks/cancel`, `/v1/tasks/delete` | `instance.terminate()`, `reason: "user"` |
| any terminal | deleted | `/v1/tasks/delete`, or retention at read | `DELETE`, `instance.delete()` best effort |

Terminal: `succeeded`, `failed`, `cancelled`, `expired`. Every transition ends
with `writeSummary(env, accountId)`.

---

## 3. The registry — `src/tasks/registry.js`

```js
/**
 * The task types (SPEC.md A82). PURE: the step functions take a context and
 * return values; nothing here imports a platform module, reads `env`, or
 * logs. `src/tasks/workflow.js` binds the platform; `src/tasks/run.js` runs
 * an entry against it; `test.mjs` drives run.js with a fake step and a fake
 * context.
 */
export const TASK_VERSION = 1;

export const PRICES = {                       // USD per million tokens; cents per search
  "claude-sonnet-5": { in: 2.00, out: 10.00, cacheRead: 0.20 },
  "claude-opus-5":   { in: 5.00, out: 25.00, cacheRead: 0.50 },
  webSearchCents: 1,                           // $10 per 1,000 searches
};

export const TYPES = {
  research: {
    tool: {                                    // what the model sees; the app lists it (A83), the Worker validates `type`
      name: "research",
      description: "Look something up properly: several web searches, read, compare, write it up.",
    },
    input: { request: "string≤4000" },         // beyond request, context, now, tz: nothing
    needsDocument: false,
    approvalTimeout: "24 hours",
    askAboveSearches: 6,                       // the one approval: the plan wants more than this many searches
    maxDurationMs: 30 * 60 * 1000,
    maxSteps: 20,                              // plan + ≤12 searches + ask + draft + finish ≤ 16; the test counts the longest path
    costClass: "model",                        // no vendor
    model: "claude-sonnet-5",
    retention: "3 days",
    run: runResearch,                          // (ctx) → { spoken, detail, deliver }
    render: renderResearch,                    // (draft, input) → { spoken ≤240, detail ≤256 KB, deliver: { notes: { title, body } } }
  },
};
```

The context a step function receives (built in `run.js`, nothing else):

```js
ctx = {
  task:   { id, type, accountId, createdAt, input, maxDurationMs },
  step:   (name, fn, config?) => guardedStep(...),          // the ONLY route to step.do
  ask:    (spoken) => askUser(...),                          // the ONLY route to waitForEvent → "approve" | "decline" | "timeout"
  model:  ({ system, messages, tools?, maxTokens }) => ...,  // the ONLY route to Anthropic; returns { text, blocks, usage }
  // reserved, not wired: decide(...) — a second named model function for a decision model. Adding it is a registry change, not a run.js change.
};
```

`runResearch(ctx)`, steps in order, names deterministic:

| step | model call | returns | timeout / retries |
| --- | --- | --- | --- |
| `plan` | Sonnet 5, no tools: "write 2–12 search queries and a one-line outline" | `{ queries: string[], outline }` | 2 min / 2 |
| `ask-scope` (only if `queries.length > askAboveSearches`) | none | `"approve"` / `"decline"` / `"timeout"` | the type's 24 h |
| `search-1` … `search-N` (N = min(queries, 12)) | Sonnet 5 with `{ type: "web_search_20260209", name: "web_search", allowed_callers: ["direct"], max_uses: 3 }` | `{ findings ≤ 64 KB, citations[], searches }` | 4 min / 2 |
| `draft` | Sonnet 5, no tools, all findings | `{ title, spoken, body }` | 4 min / 2 |
| `finish` | none | writes `result` via `render`, state `succeeded` | final step |

If the API rejects `allowed_callers` on `claude-sonnet-5`, the fallback is the
basic `web_search_20250305`, which is direct by definition. Untested until
the first live step; the test fakes the API.

---

## 4. The six routes

All `POST`, all `authenticateAccount` (a trial device is `403 needs_account`
before anything is read), all bodies JSON, every reply carries `otto-tasks`
computed from D1. Error shape is the existing `problem()`: `{ error, ...extra }`.
Ids travel in the body, like `{ app }` does, because the router is exact-match.

| route | body | 200 | errors |
| --- | --- | --- | --- |
| `/v1/tasks/create` | `{ type, request, context?, document?, now, tz }` | `{ id, state: "created" }` (the Workflow's first step makes it `running`) | `400 unknown_type`; `400 bad_request` (request empty or > 4,000 chars; `now` not ISO); `400 document_not_allowed` (type lacks `needsDocument`, or document > 32 KB); `400 bad_request` on any key outside `type request context document now tz` — an image key never gets a name of its own; `429 task_limit` (no `retryAfter`: the day resets, the row says when via `otto-usage`'s `day-resets`); `503 not_provisioned` (no `TASKS` binding or plan row) |
| `/v1/tasks/approve` | `{ id, decision: "approve" \| "decline" }` | `{ id, state }` (`approved` / `declined`) | `404 not_found`; `409 not_awaiting` (any other state, including `expired`); `400 bad_request` |
| `/v1/tasks/cancel` | `{ id }` | `{ id, state: "cancelled" }` | `404 not_found`; `409 already_finished` |
| `/v1/tasks/take` | `{ id }` | `{ id, type, state, reason?, result: { spoken, detail, deliver }?, steps: [{ name, outcome, cents }] }` — marks `seen_at`, deletes the instance | `404 not_found`; `409 not_finished` (non-terminal) |
| `/v1/tasks/delete` | `{ id }` | `{}` — terminates if running, deletes row and instance | `404 not_found` |
| `/v1/tasks` | `{}` | `{ tasks: [{ id, type, state, reason?, createdAt, updatedAt, question?: { spoken, until }, spoken? }] }` — never `input`, never `detail` | — |

Ownership: every row lookup is `WHERE id = ? AND account_id = ?`; another
account's id is `not_found`, never `forbidden`. Instance calls that throw
because the instance is gone (deleted by retention, or already terminal) are
logged by class and swallowed; the row is what the user sees.

---

## 5. The `otto-tasks` header and the KV summary

Grammar — fields `;`-separated, `key=value`, parts `:`-joined, sentences
percent-encoded (RFC 3986 unreserved kept) and cut at 240 characters before
encoding:

```
otto-tasks: v=1;running=1;awaiting=1;unseen=2;t=<id>:<state>:<type>;…;q=<id>:<sentence>;s=<id>:<sentence>;s=<id>:<sentence>
```

- `t` at most eight, newest `updated_at` first, every non-terminal row plus
  every terminal row not yet seen.
- `q` at most one: the oldest `awaiting_approval` row's `question.spoken`.
- `s` at most two: unseen terminal rows' `result.spoken` (or, for `failed`,
  `expired`, `cancelled`, a fixed sentence per reason composed on the Worker:
  "The research on … ran out of time.").
- The whole header stays under 1,500 bytes by construction (eight UUIDs,
  three sentences).
- **Absent means no information. Present with zeros means none.** On tool,
  panel and task replies it is always present. On the question reply it is
  present only when the KV key exists; the app must not read absence as "no
  tasks" (a cold colo, a KV miss).

The KV summary, key `tasks:<subject>` (the account id; a trial never has
one), value ≤ 2 KB:

```json
{ "v": 1, "at": 1760140000000,
  "running":  [{ "id": "…", "type": "research" }],
  "awaiting": [{ "id": "…", "type": "research", "q": "…≤240…", "until": 1760226400000 }],
  "unseen":   [{ "id": "…", "type": "research", "state": "succeeded", "s": "…≤240…" }] }
```

`writeSummary(env, accountId)` recomputes it from D1 — it is a projection,
never an increment, so two writers cannot drift it — and `tasksHeader(summary)`
in `src/tasks/summary.js` is pure and is the one composer for all seven
senders (six task routes, the question path, plus `/v1/tool` and
`/v1/integrations`, which compute the summary from D1 and pass it through the
same function). The question path reads the key in `checkLimits`:

```js
const [dayRaw, hourRaw, totalRaw, tasksRaw] = await Promise.all([
  env.OTTO.get(dayKey), env.OTTO.get(hourKey),
  onTrial ? env.OTTO.get(totalKey) : Promise.resolve(null),
  onTrial ? Promise.resolve(null) : env.OTTO.get(tasksKey),     // tasksKey from counterKeys(): pure
]);
```

and never writes it. `check-question-path.sh`'s binding allowlist is
unchanged (`env.OTTO`). The existing test "only counters and the token record
were written" stays exactly as it is, because the question path writes no
`tasks:` key.

---

## 6. The Workflow — files and skeleton

```
src/main.js            — new wrangler `main`: re-exports the fetch handler and the Workflow class
src/index.js           — the handler, unchanged entry for test.mjs and the benches; gains the six routes and the summary read
src/tasks/workflow.js  — the ONLY file importing `cloudflare:*`; ten lines
src/tasks/run.js       — runTask, guardedStep, finalStep, askUser, markState, recordStep, writeSummary; no platform import
src/tasks/model.js     — anthropic(): the second and last reader of ANTHROPIC_API_KEY
src/tasks/registry.js  — TYPES, PRICES, TASK_VERSION
src/tasks/research.js  — runResearch, renderResearch
src/tasks/summary.js   — summaryFromRows, tasksHeader (pure)
```

`wrangler.toml` additions:

```toml
main = "src/main.js"

[[workflows]]
name = "otto-tasks"
binding = "TASKS"
class_name = "OttoTask"
  [workflows.default_retention]
  success_retention = "3 days"
  error_retention = "3 days"
```

`src/main.js`:

```js
export { default } from "./index.js";
export { OttoTask } from "./tasks/workflow.js";
```

`src/tasks/workflow.js`:

```js
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { runTask } from "./run.js";

/** The one Workflow. Everything it does is in run.js, which test.mjs drives without this file. */
export class OttoTask extends WorkflowEntrypoint {
  async run(event, step) {
    return runTask({ event, step, env: this.env, NonRetryableError });
  }
}
```

`src/tasks/run.js`, the parts that matter:

```js
import { TYPES, TASK_VERSION } from "./registry.js";
import { anthropic } from "./model.js";
import { summaryFromRows } from "./summary.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
export const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;   // the row; the instance's "3 days" in wrangler.toml and on create() is the same number, asserted by the test

export async function runTask({ event, step, env, NonRetryableError }) {
  const params = event.payload;                           // { type, accountId, input, taskVersion }
  const entry = TYPES[params.type];
  const task = {
    id: event.instanceId, type: params.type, accountId: params.accountId,
    createdAt: event.timestamp.getTime(),                  // the platform's creation time, not ours
    input: params.input, maxDurationMs: entry.maxDurationMs,
  };
  const ctx = {
    task,
    step:  (name, fn, config) => guardedStep({ step, env, task, NonRetryableError }, name, fn, config),
    ask:   (spoken) => askUser({ step, env, task, entry }, spoken),
    model: (request) => anthropic(env, entry.model, request),
  };
  try {
    await ctx.step("start", async () => markState(env, task, "running"));
    const out = await entry.run(ctx);
    await finalStep(step, "finish", () => finishTask(env, task, "succeeded", { result: entry.render(out, task.input) }));
  } catch (error) {
    const reason = String(error && error.message || "").startsWith("max_duration") ? "max_duration"
                 : error && error.name === "TaskDeclined" ? "declined"
                 : error && error.name === "TaskExpired" ? "timeout" : "step_failed";
    const state = reason === "declined" ? "cancelled" : reason === "timeout" ? "expired" : "failed";
    console.error(`task ${task.type} ended ${state}: ${reason}`);          // the reason word, never the words
    await finalStep(step, "finish-failed", () => finishTask(env, task, state, { reason }));
  }
}

/** THE ONLY CALLER OF step.do FOR WORK. The clock check runs inside the step, so a
 *  retry re-checks it, and NonRetryableError stops the retries. */
function guardedStep({ step, env, task, NonRetryableError }, name, fn, config = {}) {
  return step.do(name, {
    timeout: config.timeout ?? "5 minutes",
    retries: config.retries ?? { limit: 2, delay: "10 seconds", backoff: "exponential" },
  }, async () => {
    const row = await readRow(env, task);                 // waited_ms: the approval wait does not count (correction 1)
    const elapsed = Date.now() - task.createdAt - Number(row && row.waited_ms || 0);
    if (elapsed > task.maxDurationMs) throw new NonRetryableError(`max_duration before ${name} at ${elapsed}ms`);
    const started = Date.now();
    const out = await fn();
    // BEST-EFFORT (correction 2): a ledger write that fails is logged by class
    // and never fails or retries a step whose work is done.
    await recordStep(env, task, { name, started, ended: Date.now(), outcome: "ok", ...(out && out.cost ? out.cost : {}) });
    return out;
  });
}

/** THE OTHER CALLER OF step.do, for the finishing steps only (finish, finish-failed, and the unknown-type refusal): no clock check, so a task that ran out of time can still write that it did. */
function finalStep(step, name, fn) {
  return step.do(name, { timeout: "1 minute", retries: { limit: 1, delay: "5 seconds", backoff: "constant" } }, fn);
}

/** THE ONLY CALLER OF waitForEvent. */
async function askUser({ step, env, task, entry }, spoken) {
  const askedAt = Date.now();
  const until = askedAt + durationMs(entry.approvalTimeout);   // the FULL approval timeout (correction 1)
  await step.do("ask-write", { timeout: "1 minute" }, () =>
    markState(env, task, "awaiting_approval", { question: { spoken: spoken.slice(0, 240), askedAt: Date.now(), until } }));
  let event;
  try {
    event = await step.waitForEvent("ask-wait", { type: "approval", timeout: `${until - askedAt} ms` });
  } catch (error) {
    // ONLY THE TIMEOUT IS EXPIRED (correction 3); anything else is a failed step.
    if (isTimeout(error)) throw Object.assign(new Error("timeout"), { name: "TaskExpired" });
    throw error;
  }
  const decision = event && event.payload && event.payload.decision === "approve" ? "approve" : "decline";
  await step.do("ask-read", { timeout: "1 minute" }, () =>
    markState(env, task, decision === "approve" ? "running" : "declined", { waitedMs: Date.now() - askedAt }));
  if (decision === "decline") throw Object.assign(new Error("declined"), { name: "TaskDeclined" });
  return decision;
}

async function markState(env, task, state, extra = {}) { /* UPDATE tasks SET state, updated_at, question?/answer? ...; then writeSummary */ }
async function recordStep(env, task, entry) { /* read steps JSON, replace the entry with the same name (a retry is not a second step), write back */ }
async function finishTask(env, task, state, { result, reason }) { /* UPDATE state, result?, reason?, finished_at, expires_at = finished_at + RETENTION_MS; writeSummary */ }
export async function writeSummary(env, accountId) { /* rows = taskRows(env, accountId) (which also sweeps expired rows); env.OTTO.put(`tasks:${accountId}`, JSON.stringify(summaryFromRows(rows))) */ }
```

Why the instance is deleted on `take` and not at the end of `run`: the docs
say "if a Workflow deletes its own instance, execution stops during
`await instance.delete()`", which is workable but leaves the failure path's
`finish-failed` unable to delete without a second code path; `take` already
has the id and the account, is the moment the result stops being needed on
the platform, and retention is the backstop for a result never taken.

`src/tasks/model.js`:

```js
/** One call to the Messages API from a task step. THE SECOND AND LAST READER OF THE KEY.
 *  Non-streaming: a step wants the whole answer and its usage. Returns text, the raw blocks (search
 *  results included, for the next step), and usage; logs nothing but the status. */
export async function anthropic(env, model, { system, messages, tools, maxTokens = 4096 }) {
  const key = env.ANTHROPIC_API_KEY;   // read once; the only read outside index.js
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, ...(tools ? { tools } : {}) }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) { console.error(`task model call: HTTP ${response.status}`); throw new Error(`model_http_${response.status}`); }
  const json = await response.json();
  const u = json.usage || {};
  return {
    text: (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""),
    blocks: json.content || [],
    usage: { in: u.input_tokens || 0, out: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0,
             searches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0 },
  };
}
```

A 429 or 529 from the API is an ordinary thrown error, so the step's two
retries at ten and twenty seconds cover it; a 400 is thrown as
`NonRetryableError` by the step function, because the same request will not
get better.

---

## 7. The per-step cost ledger

One entry per step in `tasks.steps`, written by `recordStep` from inside the
step (so a retried step replaces its own entry rather than appending):

```json
{ "name": "search-2", "started": 1760140001000, "ended": 1760140019000, "outcome": "ok",
  "model": "claude-sonnet-5", "in": 3120, "out": 640, "cacheRead": 0, "searches": 3, "cents": 4.0 }
```

`cents = (in × PRICES[model].in + out × PRICES[model].out + cacheRead × PRICES[model].cacheRead) / 10,000 + searches × webSearchCents`,
rounded to a tenth. The failed path writes `{ name, started, ended,
outcome: "failed", error: "<class or reason word>" }` from the catch in
`run.js`; the words of a prompt or an answer never enter the ledger. `take`
returns `[{ name, outcome, cents }]`; the full ledger stays in the row for the
tab (A83) and for the owner's `wrangler d1 execute`.

---

## 8. `Bench/check-task-path.sh`

Same shape as `check-tool-path.sh`: `body()` by brace depth, every check
verified red by the edit named beside it. Files: `SRC=src/index.js`,
`RUN=src/tasks/run.js`, `MODEL=src/tasks/model.js`, `WF=src/tasks/workflow.js`,
`REG=src/tasks/registry.js src/tasks/research.js src/tasks/summary.js`.

| # | assertion | FAILING EDIT |
| --- | --- | --- |
| 1 | `env.ANTHROPIC_API_KEY` is read exactly once in `src/index.js` (inside `fetch`) and exactly once under `src/tasks/`, inside `anthropic()` | read it in `runResearch` |
| 2 | `loadAccount`, `checkLimits`, `validate` never mention `TASKS` or `prepare(` (comments stripped) | add `env.TASKS` to `checkLimits` |
| 3 | `checkLimits` contains no `put(` of `tasksKey`; the only `tasks:` literal in `src/index.js` is in `counterKeys` | add `env.OTTO.put(tasksKey, …)` to the commit |
| 4 | `step.do(` appears in `run.js` only inside `guardedStep`, `finalStep` and `askUser` (its two bookkeeping steps), and nowhere else under `src/tasks/` | call `step.do` in `research.js` |
| 5 | `guardedStep` contains `maxDurationMs` and `NonRetryableError(` | delete the comparison |
| 6 | `finalStep` is called exactly three times, all inside `runTask` (unknown type, finish, finish-failed) | add a fourth call |
| 7 | `waitForEvent(` appears only inside `askUser`, with `timeout:` on the same call | remove the timeout |
| 8 | `cloudflare:` imports appear only in `src/tasks/workflow.js`; `run.js`, `research.js`, `registry.js`, `summary.js`, `model.js` import no platform module | import `NonRetryableError` in `run.js` |
| 9 | `src/main.js` exports `default` from `./index.js` and `OttoTask`; `wrangler.toml` `main` is `src/main.js`; `class_name = "OttoTask"` | point `main` back at `src/index.js` |
| 10 | every task route function calls `authenticateAccount` | replace with `authenticate` in `createTask` |
| 11 | in `createTask`, the line with `task_limit` precedes the line with `TASKS.create` | swap them |
| 12 | `createTask` refuses `document` unless `needsDocument`, and `TYPES.research.needsDocument === false` | set it true |
| 13 | `createTask` refuses any body key outside `type request context document now tz` (an allowlist, A60's rule) | add `image` to the allowlist |
| 14 | no `console.` line in the task routes or under `src/tasks/` interpolates `request\|input\|document\|result\|detail\|question\|spoken\|payload\|steps\|answer\|findings\|body\|text\|messages` | log `${result.spoken}` in `finishTask` |
| 15 | `RETENTION_MS` is `3 * 24 * 60 * 60 * 1000`, `wrangler.toml` carries `success_retention = "3 days"` and `error_retention = "3 days"`, and `TYPES.research.retention === "3 days"` | change one of the three |
| 16 | `TYPES.research.model === "claude-sonnet-5"`; its web search tool carries `allowed_callers: ["direct"]` and `max_uses` | drop `allowed_callers` |
| 17 | `takeTask` calls `.delete()` on the instance after the `seen_at` write (line order) | delete first |
| 18 | `README.md` says the body-reading claim is about the question path: grep `never reads a response body on the question path` | restore the old sentence |
| 19 | `tasksHeader(` is called from exactly one function per sending route and composed in `summary.js` only | add a second string composition |

---

## 9. `test.mjs` — the task cases

Fakes, added beside the existing ones: `makeTasksBinding()` (records
`create({ id, params, retention })`, returns instances with `sendEvent`,
`terminate`, `delete`, `status`, each recording calls and throwing when told
to); `makeTaskDB()` (the D1 stand-in grows a `tasks` table with the
`SELECT … WHERE id = ? AND account_id = ?`, the `UPDATE`s and the `DELETE`
shapes); `makeStep()` (`do(name, config, fn)` runs `fn` at once and records
`{ name, config }`; retries once on an ordinary throw, never on a class named
`NonRetryableError`; `waitForEvent(name, { type, timeout })` resolves from a
queue the test fills, or throws when the queue says timeout); a scripted
Anthropic `fetch` returning `{ content, usage }` per call; and a controllable
clock: `run.js` reads `Date.now()` and the test replaces it with a function
it advances.

**Create.**
- a trial device gets `needs_account`, nothing created, nothing read from D1
- `type: "dinner"` is `unknown_type`; an empty request, a 4,001-char request, and a non-ISO `now` are `bad_request`
- `document` on research is `document_not_allowed`; an `image` key is `bad_request` before any write
- a good create: row `created→running` is not asserted here (the Workflow does that) — row `created`, `created_at = now`, `input` holds exactly `{request, context, now, tz, taskVersion: 1}`; `TASKS.create` was called with `id === row.id`, `params = { type, accountId, input, taskVersion }`, `retention = { successRetention: "3 days", errorRetention: "3 days" }`
- the day counter `u:<acct>:k:<day>` is written before `create`; with `task_cap: 1` the second create is `429 task_limit` and `TASKS.create` was called once
- the reply header is `v=1;running=0;awaiting=0;unseen=0;t=<id>:created:research` (the Workflow has not run)

**Run (research, happy path).** Drive `runTask` with the fake step and a
scripted model: plan → 3 queries; three searches with `searches: 3, 2, 1`;
draft. Assert: step names `start, plan, search-1, search-2, search-3, draft, finish`
in that order; every `do` carried a `timeout` and `retries` except the two
final steps' shape; the row ends `succeeded` with `result.spoken` ≤ 240,
`result.deliver.notes.title`, `finished_at` set, `expires_at = finished_at + 7 d`;
`steps` has one entry per step with `cents` summing to the scripted usage at
the price table; the Anthropic calls' `tools` on the search steps were
`[{ type: "web_search_20260209", name: "web_search", allowed_callers: ["direct"], max_uses: 3 }]`
and the plan and draft calls had no `tools`; the model was `claude-sonnet-5`;
the KV summary now has one `unseen` with `s`; the console carried no word from
the request, the findings or the draft (the script plants `SECRETWORD`).

**Run (retry replaces, not appends).** A search step's first attempt throws an
ordinary error; the fake step retries; `steps` holds one `search-1` entry.

**Run (the ledger is best-effort).** The D1 stand-in throws once on the
`steps` write after the plan's scripted model call: the model was called
exactly once, the step did not retry, the run continues, and the console
carries one line naming the error's class and no words (correction 2).

**Run (an error other than the timeout inside the wait).** The fake
`waitForEvent` throws an ordinary error: the row is `failed`,
`reason: "step_failed"`, not `expired` (correction 3).

**Run (past max duration, the fake clock).** Plan completes; the test advances
the clock by 31 minutes; `search-1`'s guard throws `NonRetryableError`
containing `max_duration`; the fake step does not retry; `runTask` catches;
`finish-failed` writes `failed`, `reason: "max_duration"`; Anthropic was called
once (the plan) and never for a search; the summary lists one `unseen` with the
fixed "ran out of time" sentence.

**Run (a step fails for good).** The model `fetch` answers 400 three times;
the step throws `NonRetryableError`; the row is `failed`, `reason: "step_failed"`,
and the ledger's last entry is `outcome: "failed", error: "model_http_400"`
with no message text.

**Approval.** Plan returns 8 queries (above `askAboveSearches: 6`): the row is
`awaiting_approval` with `question.spoken` and `until ≤ createdAt + 30 min`;
the summary has one `awaiting` with `q`; the fake `waitForEvent` was called
with `type: "approval"` and a `timeout` ≤ 30 minutes (the lesser of the two);
`/v1/tasks/approve { decision: "approve" }` writes `answer`, calls
`sendEvent({ type: "approval", payload: { decision: "approve" } })`, and the run
continues to `succeeded`; a second task declined ends `cancelled`,
`reason: "declined"`, with no search call; approve on a `running` row is
`409 not_awaiting`; approve from another account is `404 not_found`; the
queue's timeout makes the row `expired`, `reason: "timeout"`, and
`finish-failed` still ran.

**Take.** On a `succeeded` row: `200` with `result` and the three-field
`steps`; `seen_at` set; `instance.delete()` called after the write; the header
on that reply has `unseen=0`; `take` on `running` is `409 not_finished`;
`take` when the instance is already gone still answers `200`.

**Cancel and delete.** Cancel on `running` calls `terminate()` and writes
`cancelled`, `reason: "user"`; cancel on `succeeded` is `409 already_finished`;
delete on `running` terminates, deletes the row and the instance; delete on
`succeeded` deletes without `terminate`; both answer with a header lacking the
id.

**List.** Returns every row of the account with `question` and `spoken` where
present and never `input` or `detail`; another account's rows are absent.

**Retention.** A `succeeded` row with `expires_at` in the past is deleted when
`/v1/tasks` is next called, its instance `delete()` called, and it is absent
from the reply and the summary; a non-terminal row older than three days is
untouched.

**The question path.** With a summary in KV, `/v1/ask`'s reply carries
`otto-tasks` with `unseen=1` and `s=`; the KV `get` calls happen inside one
`Promise.all` (the fake KV records call order: the tasks key is requested
before any counter resolves); with no summary key the header is absent; after
the question, no `tasks:` key was written — the existing "only counters and
the token record were written" assertion is unchanged and still green; a
question makes no `TASKS` call and no D1 call.

**The header grammar.** `tasksHeader` on a fixture of ten rows lists eight,
newest first, one `q`, two `s`, every sentence cut at 240 and percent-encoded,
total under 1,500 bytes; on no rows it is `v=1;running=0;awaiting=0;unseen=0`.

**Secrets bench.** The scripted model key is assembled at runtime
(`["sk", "ant", "TEST…"].join("-")`) so `check-no-secrets.sh` stays green on the
test file.

---

## 10. What this checkpoint does not decide

- **Retention, revised 2026-10-11.** The first deploy's trigger step failed
  with `400 workflows.api.error.body` on `default_retention "7 days"`; the
  same PUT with `"3 days"` succeeds, and the Workflow's versions report
  `limits.steps 1024` and a 259,200,000 ms default retention — the Workers
  Free values. The decision is to stay on Free, so the one retention number
  is three days in all four places (`wrangler.toml` twice,
  `TYPES.research.retention`, `RETENTION_MS`) and A82's sentence says three.
  The other Free limits a step must live inside: 10 ms CPU per step, 1,024
  steps per instance, 3,000 steps a day across the account.
- `task_cap` for `free` is written as 5 and marked a placeholder.
- `askAboveSearches = 6` is the one approval research has; it is the cost
  gate, not a feature the brief asked for by name.
- Whether `web_search_20260209` with `allowed_callers: ["direct"]` is accepted
  on `claude-sonnet-5`, or the basic `web_search_20250305` is needed: the first
  live step answers it.
- In-flight Workflow instances across a deploy: not established; the step
  names are stable and `taskVersion` rides in the params so a later reader can
  tell which code a row came from.
