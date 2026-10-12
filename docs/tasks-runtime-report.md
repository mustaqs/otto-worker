# The tasks runtime, as built — Phase 4 report for `tasks-runtime` (A82)

Branch `tasks-runtime` off `otto-worker` main `4caa674`, eleven commits
`ea3ffb2..ebf9d03` plus this report. Deployed to production four times on
2026-10-11/12; the live version as this is written is
`2f07b2ab-b6a5-4efe-a2bc-46680dbb69c8` (commit `ebf9d03`). Migration
`0005_tasks.sql` applied by hand. The design checkpoint is
`docs/tasks-runtime-design.md`; this file records what was applied, what the
live runs measured, and where the two differ.

## 1. A82 as applied — the runtime half

**Tasks: a Workflow on the relay, delivered on the next question.** Otto can
start work that outlasts a question and finish it while the user does
something else. The work runs on the relay as a Cloudflare Workflow; nothing
runs on the Mac between questions, and the result waits on the relay until
the next chord or the next panel open carries it home.

1. **The runtime is Cloudflare Workflows and the hard maximum is ours.** No
   instance duration cap exists, so every working step goes through one
   function, `guardedStep`, that compares the clock against the instance's
   creation time and throws `NonRetryableError` past the type's
   `maxDurationMs` (research: 30 minutes, 20 steps). **Time spent awaiting
   approval does not count:** the wait is recorded on the row as
   `waited_ms` when it resolves and subtracted from the clock, and the wait
   uses the type's full `approvalTimeout` (24 hours). Measured live: a task
   that asked at second 7 and was approved 33 seconds later recorded
   `waited_ms 33171`; the test asks at minute 2 and approves at hour 3,
   once in one run and once across a replay.
2. **One Workflow class, a registry of types.** `OttoTask` dispatches on
   `params.type` to `src/tasks/registry.js`. An entry declares the tool, the
   limits, `needsDocument`, `approvalTimeout`, `maxDurationMs`, `maxSteps`,
   the model, `centsPerSearch`, the step function and a renderer. The step
   function reaches a model only through `ctx.model`, the second reader of
   `ANTHROPIC_API_KEY` in the Worker and the first reader of a response
   body; the README's pass-through claim is restated to the question path.
   The context leaves room for a decision model and wires none.
3. **The row is the truth; the instance is the engine.** D1 `tasks` holds
   id, account, type, one of nine states, input (request, window line,
   `now`, `tz`, `taskVersion`; never a screenshot; a document only for a
   type that declares it, and research does not), the per-step ledger, the
   question, the answer, the result, the reason, `waited_ms`, seen, created,
   updated, finished, expires. **Retention is three days** after a terminal
   state, a comparison at read; the Workflow's own copy is set to the same
   three days and deleted when the result is taken. Three is the Workers
   Free cap on instance retention: the deploy's `PUT /workflows/otto-tasks`
   answers `400 workflows.api.error.body` to seven days and `200` to three.
4. **Delivery rides what already travels.** The `otto-tasks` header
   (`v=1;running=N;awaiting=N;unseen=N;t=…;q=…;s=…`) is exact on tool and
   panel replies and comes from one KV key per account on the question
   reply, read inside the counters' `Promise.all` and never written there.
   `/v1/tasks/take` returns the detail, marks the row seen, deletes the
   instance. Nothing happens if the user never asks again.
5. **Approval is an event.** A step that needs a yes writes the question,
   moves the row to `awaiting_approval`, and waits on `step.waitForEvent`
   for the full 24 hours. `/v1/tasks/approve` checks the row is awaiting and
   sends the event. Only the wait's timeout becomes `expired`; any other
   error is `step_failed`. Research asks once at most, when its plan needs
   more than six searches, and says `queries × centsPerSearch` cents.
6. **Metering.** `task_cap` on the plan row (free 5, beta 0 = no gate), a
   day counter in KV, checked and counted before the create. Every step
   records model, tokens in and out, cache reads, searches and cents.
7. **The search step is bounded.** `max_uses: 2`, 1,024 output tokens,
   4,096 characters of findings to the draft, and a prompt that searches
   once unless the first results do not answer.

**What A62's claim becomes:** one request to start a task and one to collect
the result; approving, cancelling and deleting are one each, when done.
**The privacy page gains:** "the work runs on our relay, not on your Mac,
and the result waits there until you next ask Otto something or open its
menu. We keep what you asked for, the steps it took and the result for three
days or until you delete them, and nothing else about it."

**Does not:** read a response body on the question path; put D1 on the
question path; store a screenshot; run anything on the Mac; notify; retry an
approval; carry a result in a header; let a step name depend on a clock.

**Three things the platform does that the docs did not say**, each measured
on 2026-10-11, copied by the test's step stand-in and pinned by a bench
check: an error thrown inside `step.do` reaches the caller as a fresh
`Error` whose message is `"<name>: <message>"` and nothing else; after a
hibernated wait the engine replays `run()` from the top with finished steps
served from their cached outputs, so nothing computed outside a step
survives; a deleted instance answers `Status: Terminated` for a while and
`instance.not_found` later.

## 2. Per-file diff (`git diff --stat main...tasks-runtime`, 15 files, +2,789 −14)

| file | lines | what |
| --- | --- | --- |
| `migrations/0005_tasks.sql` | +33 | the `tasks` table, its index, `task_cap` on plans (free 5, beta 0) |
| `src/tasks/registry.js` | +73 | `TASK_VERSION`, `PRICES`, `CREATE_KEYS`, limits, `TYPES.research`, `centsOf`, `costOf` |
| `src/tasks/research.js` | +153 | plan, the cost gate, `search-1..N` (N ≤ 12), draft, the renderer, `citationsOf` |
| `src/tasks/summary.js` | +92 | `TERMINAL`, `summaryFromRows`, `tasksHeader` — the one composer |
| `src/tasks/model.js` | +60 | `anthropic()`: the second key reader, non-streaming, logs the status only |
| `src/tasks/run.js` | +325 | `runTask`, `guardedStep`, `finalStep`, `askUser`, the D1 helpers, `finishTask`, the sweep |
| `src/tasks/workflow.js` | +15 | `OttoTask`, the only importer of `cloudflare:*` |
| `src/main.js` | +7 | wrangler's entry: the handler and `OttoTask` |
| `src/index.js` | +318 | six routes before `/v1/ask`; `checkLimits` reads the summary; the header on tool and panel replies; `task_cap` |
| `wrangler.toml` | +16 −2 | `main = src/main.js`; `[[workflows]]` with three-day default retention |
| `Bench/check-task-path.sh` | +280 | 36 checks, 28 with a named failing edit |
| `test.mjs` | +638 | the task block: 166 checks on main, 253 on the branch |
| `README.md` | +51 −2 | the question-path restatement and "Tasks (A82)" |
| `package.json` | +1 −1 | `npm run check` runs the new bench |
| `docs/tasks-runtime-design.md` | +732 | the Phase 1 checkpoint, with section 10 carrying what the live runs changed |

## 3. Bench evidence

`npm run check` on `ebf9d03`: `NO SECRETS OK`, `QUESTION PATH OK`,
`TOOL PATH OK`, `TASK PATH OK` (36 checks), `PLAN SYNC OK`; `node test.mjs`
`ALL PASS`, 253 checks. Every check added after the design checkpoint was
shown red against the commit before it, by swapping in the previous file
and running the bench. The 36:

- the key is read once in index.js and once under src/tasks/, inside anthropic()
- loadAccount, checkLimits and validate never name the Workflow binding or D1 (three checks)
- checkLimits reads the task summary and never writes it
- the one `tasks:` key literal in index.js is in counterKeys
- step.do is called only inside guardedStep, finalStep and askUser
- guardedStep compares the clock against maxDurationMs and throws NonRetryableError, and forgives the time spent awaiting approval (two checks)
- finalStep is called three times, all inside runTask
- waitForEvent has one caller, askUser, and it passes a timeout
- only the wait's timeout becomes expired; any other error is rethrown
- recordStep is best-effort: it catches, logs and never throws
- the failed ledger entry is written inside guardedStep's catch before the rethrow; runTask reads nothing off the engine's error
- the wait's start is the ask-write step's output, so a replay after hibernation keeps it
- max_duration is found as a word in the message the engine prefixes with the error's name
- the platform is imported in workflow.js and nowhere else
- wrangler's main is src/main.js, which re-exports the handler and OttoTask
- createTask, listTasks and taskFromBody require an account behind the bearer; approve, cancel, take and delete go through taskFromBody (seven checks)
- createTask checks the cap, counts, then creates, in that order
- createTask refuses a document unless the type declares needsDocument, and research does not (two checks)
- the create body is an allowlist of six keys
- takeTask marks the row seen before it deletes the instance
- no log line in the task routes or src/tasks/ interpolates a request, a result, a question or a row
- the row, the binding's default_retention (both) and research's retention are all three days
- research runs on claude-sonnet-5 with direct, bounded web search
- a search step is bounded (1,024 output tokens, 4,096 characters to the draft) and the question's estimate is the registry's centsPerSearch
- the otto-tasks header is composed in summary.js and nowhere else
- the README's body-reading claim names the question path

The test block's step stand-in rethrows the way the engine does, caches
outputs by name, and can park a wait; a `beforeExit` guard fails the file
aloud if a parked promise drains the loop.

## 4. The live runs

All four against production with the account's device token (the baked
relay token is legacy v1 and answers `needs_account`), the row watched in
D1 every 20 seconds. Request 1 and 2: "compare Cloudflare Workflows and
Durable Objects for long-running tasks". Request 3: "what is the maximum
retention for completed Cloudflare Workflow instances on the Workers Free
plan". Request 4: "what are the Cloudflare Workflows limits on the Workers
Free plan: steps per instance, CPU time per step, instance retention, and
concurrent instances".

### Run 1 — `f507eb6e`, 19:55 UTC, deploy `9c77abe6` — failed, and found two defects

| step | started at | took | outcome |
| --- | --- | --- | --- |
| start | +2.1 s | 0.2 s | ok |
| plan | +2.4 s | 4.1 s | ok, 12 queries, 0.4 ¢ |
| ask-write / ask-wait | +7 s | 33 min 35 s | approved via the route at 20:29:25 |
| search-1 | +33 min 42 s | 0 ms | **failed** `NonRetryableError: max_duration before search-1 at 2021477ms` |

The row recorded `waited_ms 64` for the 34-minute wait and `reason:
step_failed`. Causes, both measured on the instance record: the engine
replays `run()` after a hibernated wait and the wait's start was a local;
the engine prefixes the rethrown message with the error's name. Fixed in
`86de12b`. Before this run, `c1f4227` had fixed a third defect seen on the
first attempt of the day (`4813e234`, deploy with the invalid key): the
failed step's ledger entry was never written, because the properties
`runTask` read off the error did not survive the rethrow.

### Run 2 — `27ad6d37`, 20:35 UTC, deploy `667c6e93` — succeeded, approval path

| step | started at | took | in | out | searches | ¢ |
| --- | --- | --- | --- | --- | --- | --- |
| start | +2.1 s | 0.2 s | | | | |
| plan | +2.4 s | 4.2 s | 161 | 330 | 0 | 0.4 |
| ask | +7 s | 33.2 s | question "This needs about 10 searches, roughly 30 cents. Go ahead?"; header `awaiting=1;…;q=<id>:This%20needs…` | | | |
| search-1 | +40.1 s | 20.0 s | 20,885 | 2,183 | 2 | 8.4 |
| search-2 | +60.2 s | 21.4 s | 19,527 | 2,207 | 2 | 8.1 |
| search-3 | +82.1 s | 20.4 s | 21,912 | 2,210 | 2 | 8.6 |
| search-4 | +102.6 s | 19.9 s | 21,276 | 2,179 | 2 | 8.4 |
| search-5 | +122.6 s | 20.6 s | 20,477 | 2,145 | 2 | 8.2 |
| search-6 | +143.3 s | 19.8 s | 19,444 | 2,182 | 2 | 8.1 |
| search-7 | +163.2 s | 20.3 s | 20,491 | 2,158 | 2 | 8.3 |
| search-8 | +183.6 s | 18.7 s | 20,183 | 1,914 | 2 | 8.0 |
| search-9 | +202.3 s | 19.6 s | 20,243 | 2,218 | 2 | 8.3 |
| search-10 | +222.0 s | 19.0 s | 19,312 | 2,216 | 2 | 8.1 |
| draft | +241.2 s | 19.3 s | 21,774 | 1,937 | 0 | 6.3 |

Total 89.2 ¢, 260.6 s wall, `waited_ms 33171`, `expires_at − finished_at`
= 3.0 days. Spoken: "Use Workflows for multi-step tasks that need retries
and can sleep or wait, and Durable Objects for a single stateful entity
like a chat room or live session." `/v1/tasks` before take:
`unseen=1;t=<id>:succeeded:research;s=<id>:Use%20Workflows…`; after take:
`v=1;running=0;awaiting=0;unseen=0`; `seen_at` set; the instance gone from
`workflows instances list` at once, `Terminated` on describe for a while,
`instance.not_found` 80 minutes later. `web_search_20260209` with
`allowed_callers ["direct"]` was accepted by claude-sonnet-5 on every step;
no fallback exists or was needed.

### Run 3 — `8d97dfc9`, 20:41 UTC, deploy `667c6e93` — succeeded, no ask

| step | started at | took | in | out | searches | ¢ |
| --- | --- | --- | --- | --- | --- | --- |
| plan | +1.3 s | 2.4 s | 173 | 149 | 0 | 0.2 |
| search-1 | +3.8 s | 8.6 s | 31,593 | 547 | 2 | 8.9 |
| search-2 | +12.5 s | 5.0 s | 13,309 | 315 | 1 | 4.0 |
| search-3 | +17.7 s | 5.1 s | 13,912 | 346 | 1 | 4.1 |
| search-4 | +22.9 s | 5.7 s | 20,417 | 469 | 2 | 6.6 |
| draft | +28.7 s | 5.6 s | 2,730 | 633 | 0 | 1.2 |

Total 25.0 ¢, 34.4 s. Spoken: "On the Workers Free plan, completed
Cloudflare Workflow instance state is retained for a maximum of 3 days."
Left untaken until the end of the session so the `s=` header was live on
`/v1/tasks`; then taken.

### Run 4 — `f97f67a0`, 02:01 UTC 2026-10-12, deploy `50ac6cef` — the bounded step

| step | started at | took | in | out | searches | ¢ |
| --- | --- | --- | --- | --- | --- | --- |
| plan | +2.8 s | 2.7 s | 191 | 214 | 0 | 0.3 |
| search-1 | +5.7 s | 7.4 s | 13,127 | 555 | 1 | 4.2 |
| search-2 | +13.2 s | 8.4 s | 13,572 | 725 | 1 | 4.4 |
| search-3 | +21.7 s | 9.5 s | 12,985 | 847 | 1 | 4.4 |
| search-4 | +31.3 s | 12.3 s | 13,290 | 1,105 | 1 | 4.8 |
| search-5 | +43.8 s | 8.0 s | 13,128 | 690 | 1 | 4.3 |
| search-6 | +51.9 s | 8.6 s | 14,440 | 739 | 1 | 4.6 |
| draft | +60.7 s | 14.8 s | 5,270 | 1,440 | 0 | 2.5 |

Total 29.5 ¢, 75.6 s. Six queries, exactly `askAboveSearches`, so no ask.
Spoken: "On the Workers Free plan, Workflows allow 1,024 steps per
instance, 10 ms CPU time per step, 3-day instance retention, and 100
concurrent instances." Taken; the instance deleted.

## 5. Cost per search, before and after

| | run 2 (unbounded) | run 4 (bounded) |
| --- | --- | --- |
| searches per step | 2 | 1 |
| input tokens per step | ~20,500 | ~13,400 |
| output tokens per step | ~2,160 | ~780 |
| cents per search step | 8.0–8.6 | 4.2–4.8 |
| draft input tokens | 21,774 | 5,270 |
| task total | 89.2 ¢ / 10 searches | 29.5 ¢ / 6 searches |
| all-in cents per planned search | 8.9 | 4.9 |
| what the question would say | 30 (at 3) | 54 (at 9) → 30 (at 5) |

Where a step's cents go at the price table (Sonnet 5: $2 in, $10 out per
million; 1 ¢ a search): on run 2, input 4.1 + output 2.2 + searches 2.0;
on run 4, input 2.7 + output 0.8 + searches 1.0. The input is the search
results the API feeds back inside the request, counted once per search
iteration, so it falls with the number of searches and with nothing else
we send: the direct search tool has no parameter for result size. The
estimate went from 3 (the design's placeholder) to 9 (run 2's all-in) to
**5** (run 4's all-in, 4.9, within 2% of the measured task); 9 against run
4 would have been 83% high, so 5 is what was committed and deployed.

## 6. Production as left, and what is not established

Rows `27ad6d37`, `8d97dfc9` and `f97f67a0` are `succeeded` and seen,
instances deleted, expiring three days after they finished. Rows `4813e234`
and `f507eb6e` were deleted through the route. The day counter was reset
once on 2026-10-11 and stands at 1 for 2026-10-12. The Workflow `otto-tasks`
carries the versions each deploy made plus two from the diagnostic PUTs.
Four live tasks and one question spent about $1.45 of API usage.

Not established: what an in-flight instance runs after a redeploy (no run
spanned one); the 10 ms CPU limit per step (no step tripped it; the steps
are I/O); the one-minute lag of the question reply's header (not timed);
the platform's timeout error class on `waitForEvent` (no wait expired
live, so `isTimeout` still matches by name then message); the decline path
live (tested, not run). `ANTHROPIC_API_KEY` is the console key `otto-1`;
the day's first failures were that key revoked, not the branch.

## 7. Next

`tasks-app` (Otto): the `create_task` tool as a Mac-first app in the
overflow budget, the voice approval sets, the header read on every reply,
`/v1/tasks/take` on the delivering chord, the note filed; then `tasks-tab`.
