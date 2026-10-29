#!/bin/bash
#
# Asserts what the task runtime may and may not touch (SPEC.md A82).
#
# Four claims, each verified by grep because reading is what lets them drift:
#   1. The key has exactly two readers: the question path's pass-through in
#      src/index.js and anthropic() in src/tasks/model.js. No third.
#   2. The question path reads the task rows (from D1, since 2026-10-29)
#      with one SELECT, never writes them and never names the Workflow
#      binding.
#   3. Every unit of task work goes through guardedStep, which carries the
#      max-duration comparison; the wait has one caller and a timeout; the
#      platform is imported in one file.
#   4. No log line in the task code interpolates a request, a result or a
#      question; the retention is one number in three places; research is
#      on the model and the search variant the decision named.
#
# check-question-path.sh still guards the question path's bindings; this file
# is about the task routes and the Workflow and says nothing about /v1/ask
# beyond what the task summary added to it.
#
# Every check has been verified to go red — see the FAILING EDIT comments.

set -u
cd "$(dirname "$0")/.." || exit 2
SRC=src/index.js
RUN=src/tasks/run.js
MODEL=src/tasks/model.js
WF=src/tasks/workflow.js
REG=src/tasks/registry.js
RESEARCH=src/tasks/research.js
BROWSER=src/tasks/browser.js
SUMMARY=src/tasks/summary.js
FEED=src/tasks/feed.js
MAIN=src/main.js
TOML=wrangler.toml
PURE="$RUN $MODEL $REG $RESEARCH $SUMMARY $FEED"

fail=0
check() {
    if [ "$2" = "0" ]; then printf '  ok   %s\n' "$1"
    else printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); fi
}

for f in $SRC $RUN $MODEL $WF $REG $RESEARCH $SUMMARY $FEED $MAIN $TOML; do
    [ -f "$f" ] || { echo "FAIL: no $f"; exit 2; }
done

# One function body by brace depth, from the named file.
body() { # file name
    awk -v name="$2" '
        (index($0, "function " name "(") || index($0, "async function " name "(")) && !started { started = 1 }
        started {
            print
            n = gsub(/\{/, "{"); m = gsub(/\}/, "}")
            depth += n - m
            if (opened || n > 0) { opened = 1; if (depth <= 0) exit }
        }
    ' "$1"
}
strip() { sed 's|//.*||' "$@"; }

echo "tasks — the key:"

# THREE READERS SINCE A89 §11: the question's pass-through, the browser
# step's pass-through (askStep), and anthropic() for the Workflow.
# FAILING EDIT: read env.ANTHROPIC_API_KEY in runResearch (research.js), or in stepTask.
in_index=$(grep -c "env\.ANTHROPIC_API_KEY" "$SRC")
in_askstep=$(body "$SRC" askStep | grep -c "env\.ANTHROPIC_API_KEY")
in_tasks=$(cat $RUN $MODEL $WF $REG $RESEARCH $BROWSER $SUMMARY $FEED | grep -c "env\.ANTHROPIC_API_KEY")
in_fn=$(body "$MODEL" anthropic | grep -c "env\.ANTHROPIC_API_KEY")
if [ "$in_index" = "2" ] && [ "$in_askstep" = "1" ] && [ "$in_tasks" = "1" ] && [ "$in_fn" = "1" ]; then
    check "the key is read twice in index.js (the question, askStep) and once under src/tasks/, inside anthropic()" 0
else
    check "the key is read twice in index.js (the question, askStep) and once under src/tasks/, inside anthropic()" 1
    printf '       index.js: %s, askStep: %s, src/tasks: %s, inside anthropic(): %s\n' "$in_index" "$in_askstep" "$in_tasks" "$in_fn"
fi

echo "tasks — the question path:"

# FAILING EDIT: add `env.TASKS` on a comment-free line of checkLimits.
for fn in loadAccount checkLimits validate; do
    text=$(body "$SRC" "$fn" | sed 's|//.*||')
    if [ -z "$text" ]; then check "$fn — NOT FOUND, so nothing was checked" 1; continue; fi
    case "$text" in
        *TASKS*|*prepare\(*) check "$fn never names the Workflow binding or D1" 1 ;;
        *)                   check "$fn never names the Workflow binding or D1" 0 ;;
    esac
done

# SINCE 2026-10-29 THE QUESTION READS THE ROWS: summaryQuery, one SELECT in
# checkLimits's batch. It writes nothing and deletes nothing — an expired row
# is left out, never swept, on the path every question takes.
# FAILING EDIT: change summaryQuery's SELECT to `DELETE FROM tasks WHERE …`.
query=$(body "$RUN" summaryQuery | sed 's|//.*||')
if [ -n "$query" ] && echo "$query" | grep -q 'SELECT id, type, state' \
   && ! echo "$query" | grep -qE 'INSERT|UPDATE|DELETE|env\.OTTO'; then
    check "the question's task read is one SELECT, and writes nothing" 0
else
    check "the question's task read is one SELECT, and writes nothing" 1
fi
# FAILING EDIT: add `json_extract(result, '$.detail')` (or `result,`) to summaryQuery's columns.
cols=$(echo "$query" | tr '\n' ' ' | sed 's/.*SELECT \(.*\) FROM tasks.*/\1/')
plain=$(echo "$cols" | sed "s/json_extract(result, '\$\.spoken')//; s/json_extract(input, '\$\.host')//")
case "$plain" in
    *detail*|*result*|*input*|*"*"*) check "it reads the sentence and host, never the detail or the request" 1 ;;
    *)                               check "it reads the sentence and host, never the detail or the request" 0 ;;
esac

# THE KV COPY IS GONE: no `tasks:` key is written or read anywhere.
# FAILING EDIT: put `env.OTTO.put(`tasks:${accountId}`, "x")` back in run.js.
literals=$(for f in $SRC $RUN $FEED; do strip "$f"; done | grep -c '`tasks:')
[ "$literals" = "0" ]
check "no tasks: KV key anywhere: the summary is read from D1, never copied" $?

echo "tasks — the Workflow:"

# step.do is called from guardedStep (work), finalStep (two finishing steps)
# and askUser (two bookkeeping steps around the wait), and nowhere else.
# FAILING EDIT: call `step.do(` in research.js, or add a fourth caller in run.js.
total=$(cat $RUN $REG $RESEARCH $SUMMARY $MODEL | sed 's|//.*||' | grep -c "step\.do(")
allowed=$(for fn in guardedStep finalStep askUser; do body "$RUN" "$fn"; done | sed 's|//.*||' | grep -c "step\.do(")
if [ "$total" -gt 0 ] && [ "$total" = "$allowed" ]; then
    check "step.do is called only inside guardedStep, finalStep and askUser" 0
else
    check "step.do is called only inside guardedStep, finalStep and askUser" 1
    printf '       calls in task code: %s, inside the three: %s\n' "$total" "$allowed"
fi

# FAILING EDIT: delete the `elapsed > task.maxDurationMs` line from guardedStep.
guarded=$(body "$RUN" guardedStep | sed 's|//.*||')
echo "$guarded" | grep -q "maxDurationMs" && echo "$guarded" | grep -q "NonRetryableError("
check "guardedStep compares the clock against maxDurationMs and throws NonRetryableError" $?

# FAILING EDIT: delete `waited_ms` from guardedStep's elapsed line.
echo "$guarded" | grep -q "waited_ms"
check "and forgives the time spent awaiting approval (waited_ms)" $?

# FAILING EDIT: add a third `finalStep(` call anywhere in runTask.
finals=$(strip "$RUN" | grep -v "function finalStep" | grep -c "finalStep(")
in_run=$(body "$RUN" runTask | sed 's|//.*||' | grep -c "finalStep(")
if [ "$finals" = "3" ] && [ "$in_run" = "3" ]; then
    check "finalStep is called three times, all inside runTask (unknown type, finish, finish-failed)" 0
else
    check "finalStep is called three times, all inside runTask (unknown type, finish, finish-failed)" 1
    printf '       calls: %s, inside runTask: %s\n' "$finals" "$in_run"
fi

# FAILING EDIT: remove `timeout:` from either waitForEvent call, or call
# waitForEvent in research.js or browser.js. Two callers since A89: askUser
# (the approval) and awaitStep (the browser ledger's "a step was posted").
waits=$(cat $RUN $REG $RESEARCH $BROWSER $SUMMARY $MODEL | sed 's|//.*||' | grep -c "waitForEvent(")
in_ask=$(body "$RUN" askUser | sed 's|//.*||' | grep "waitForEvent(" | grep -c "timeout:")
in_step=$(body "$RUN" awaitStep | sed 's|//.*||' | grep "waitForEvent(" | grep -c "timeout: entry.idleTimeout")
if [ "$waits" = "2" ] && [ "$in_ask" = "1" ] && [ "$in_step" = "1" ]; then
    check "waitForEvent has two callers, askUser and awaitStep, and each passes a timeout" 0
else
    check "waitForEvent has two callers, askUser and awaitStep, and each passes a timeout" 1
fi
# FAILING EDIT: throw TaskIdle for every error in awaitStep.
idle=$(body "$RUN" awaitStep | sed 's|//.*||')
echo "$idle" | grep -q 'const idle = isTimeout(error);' && echo "$idle" | grep -q 'if (idle) throw Object.assign(new Error("idle"), { name: "TaskIdle" });' && echo "$idle" | grep -q "throw error;"
check "only the idle wait's timeout becomes expired (idle); any other error is rethrown" $?

# FAILING EDIT: replace `if (isTimeout(error)) throw` with an unconditional throw of TaskExpired.
ask=$(body "$RUN" askUser | sed 's|//.*||')
echo "$ask" | grep -q "isTimeout(error)" && echo "$ask" | grep -A1 "isTimeout(error)" | grep -q "TaskExpired" && echo "$ask" | grep -q "throw error;"
check "only the wait's timeout becomes expired; any other error is rethrown" $?

# FAILING EDIT: delete the try/catch in recordStep so a failed write throws.
record=$(body "$RUN" recordStep)
echo "$record" | grep -q "try {" && echo "$record" | grep -q "catch (error)" && ! echo "$record" | sed 's|//.*||' | grep -q "throw"
check "recordStep is best-effort: it catches, logs and never throws" $?

# FAILING EDIT: move the recordStep out of guardedStep's catch into runTask's
# catch, keyed on a property set on the error (the shape the live run of
# 2026-10-11 showed never arrives: the engine rethrows only name and message).
guarded=$(body "$RUN" guardedStep | sed 's|//.*||')
echo "$guarded" | grep -A10 "catch (error)" | grep -q 'recordStep(env, task, { name, started, ended: Date.now(), outcome: "failed"' \
    && [ "$(sed 's|//.*||' "$RUN" | grep -c 'taskStep')" = "0" ]
check "the failed ledger entry is written inside guardedStep's catch before the rethrow; runTask reads nothing off the engine's error" $?

# FAILING EDIT: take askedAt from Date.now() at the top of askUser instead of
# the ask-write step's output (what the live run of 2026-10-11 did: after the
# hibernated wait the engine replays run() and a local is the replay's time).
ask=$(body "$RUN" askUser | sed 's|//.*||')
echo "$ask" | grep -q 'const asked = await step.do(`ask-write${suffix}`' && echo "$ask" | grep -q 'return { askedAt, until };' \
    && ! echo "$ask" | grep -q '^  const askedAt = Date.now()' && echo "$ask" | grep -q 'waitedMs: Date.now() - asked.askedAt'
check "the wait's start is the ask-write step's output, so a replay after hibernation keeps it" $?

# FAILING EDIT: classify the reason with message.startsWith("max_duration").
grep -q 'max_duration\\b/.test(message)' "$RUN" && ! grep -q 'startsWith("max_duration")' "$RUN"
check "max_duration is found as a word in the message the engine prefixes with the error's name" $?

# FAILING EDIT: import NonRetryableError from "cloudflare:workflows" in run.js.
elsewhere=$(cat $PURE "$SRC" | sed 's|//.*||' | grep -c '"cloudflare:')
in_wf=$(sed 's|//.*||' "$WF" | grep -c '"cloudflare:')
if [ "$elsewhere" = "0" ] && [ "$in_wf" = "2" ]; then
    check "the platform is imported in workflow.js and nowhere else" 0
else
    check "the platform is imported in workflow.js and nowhere else" 1
    printf '       cloudflare: imports outside workflow.js: %s, inside: %s\n' "$elsewhere" "$in_wf"
fi

# FAILING EDIT: point `main` back at src/index.js, or rename the class.
grep -q '^main = "src/main.js"' "$TOML" && grep -q 'class_name = "OttoTask"' "$TOML" \
    && grep -q 'export { default } from "./index.js"' "$MAIN" && grep -q 'export { OttoTask } from "./tasks/workflow.js"' "$MAIN"
check "wrangler's main is src/main.js, which re-exports the handler and OttoTask" $?

echo "tasks — the routes:"

TASK_FUNCS="createTask approveTask cancelTask takeTask deleteTask listTasks feedTasks taskFromBody"
# FAILING EDIT: replace authenticateAccount with authenticate in createTask.
for fn in createTask listTasks feedTasks taskFromBody; do
    case "$(body "$SRC" "$fn")" in
        *authenticateAccount*) check "$fn requires an account behind the bearer" 0 ;;
        *)                     check "$fn requires an account behind the bearer" 1 ;;
    esac
done
for fn in approveTask cancelTask takeTask deleteTask; do
    case "$(body "$SRC" "$fn")" in
        *taskFromBody*) check "$fn goes through taskFromBody" 0 ;;
        *)              check "$fn goes through taskFromBody" 1 ;;
    esac
done

# FAILING EDIT: move the task_limit check below env.TASKS.create in createTask.
create=$(body "$SRC" createTask)
limit_line=$(echo "$create" | grep -n '"task_limit"' | head -1 | cut -d: -f1)
create_line=$(echo "$create" | grep -n 'TASKS\.create' | head -1 | cut -d: -f1)
put_line=$(echo "$create" | grep -n 'bump(env, accountId, \[\[b.task' | head -1 | cut -d: -f1)
if [ -n "$limit_line" ] && [ -n "$create_line" ] && [ -n "$put_line" ] && [ "$limit_line" -lt "$put_line" ] && [ "$put_line" -lt "$create_line" ]; then
    check "createTask checks the cap, counts, then creates — in that order" 0
else
    check "createTask checks the cap, counts, then creates — in that order" 1
fi

# FAILING EDIT: set `needsDocument: true` on research, or drop the refusal.
echo "$create" | grep -q '"document_not_allowed"' && echo "$create" | grep -q "needsDocument"
check "createTask refuses a document unless the type declares needsDocument" $?
grep -A12 "research: {" "$REG" | grep -q "needsDocument: false"
check "and research does not" $?

# FAILING EDIT: add "image" to CREATE_KEYS, or remove the allowlist loop.
# Seven since A91 added `title`, which is text, checked as text, and bounded.
# Nine since A89 added a browser task's `mode` and `url`, accepted for that
# type alone, the mode from a closed set and the url only as https.
grep -q 'CREATE_KEYS = \["type", "request", "title", "mode", "url", "context", "document", "now", "tz"\]' "$REG" \
    && echo "$create" | grep -q "CREATE_KEYS.includes(key)" \
    && echo "$create" | grep -q 'typeof body.title !== "string"' \
    && echo "$create" | grep -q 'if (!BROWSER_MODES.includes(mode))' \
    && echo "$create" | grep -q 'start.protocol !== "https:"' \
    && echo "$create" | grep -q '} else if (body.mode !== undefined || body.url !== undefined) {'
check "the create body is an allowlist of nine keys, so an image has no name to arrive under" $?

# FAILING EDIT: drop `seen: true` from cancelTask's finishTask, or the
# `seen: decision === "decline"` from approveTask's markState. A row the user
# ended knowingly must not ride the next header as unseen.
body "$SRC" cancelTask | grep -q 'finishTask(env, task, "cancelled", { reason: "user", seen: true })' \
    && body "$SRC" approveTask | grep -q 'seen: decision === "decline"'
check "the user's own cancel and decline mark the row seen" $?

# FAILING EDIT: move `deleteInstance` above `markSeen` in takeTask.
take=$(body "$SRC" takeTask)
seen_line=$(echo "$take" | grep -n "markSeen(" | head -1 | cut -d: -f1)
del_line=$(echo "$take" | grep -n "deleteInstance(" | head -1 | cut -d: -f1)
if [ -n "$seen_line" ] && [ -n "$del_line" ] && [ "$seen_line" -lt "$del_line" ]; then
    check "takeTask marks the row seen before it deletes the instance" 0
else
    check "takeTask marks the row seen before it deletes the instance" 1
fi

echo "tasks — the feed (A84):"

# FAILING EDIT: call `instance.subscribe(` from listTasks in index.js, or
# from a second function in feed.js.
subs=$(cat $PURE "$SRC" | sed 's|//.*||' | grep -c "\.subscribe(")
in_follow=$(body "$FEED" follow | sed 's|//.*||' | grep -c "\.subscribe(")
if [ "$subs" = "1" ] && [ "$in_follow" = "1" ]; then
    check "subscribe is called once, inside feed.js's follow" 0
else
    check "subscribe is called once, inside feed.js's follow" 1
    printf '       calls: %s, inside follow: %s\n' "$subs" "$in_follow"
fi

# FAILING EDIT: forward `event.output` in a step frame, or read `result.detail`
# in projectRow. A step's output is the findings; the detail is the write-up.
! sed 's|//.*||' "$FEED" | grep -qE "\.output\b|\.detail\b|notes\.body|\.findings\b"
check "the feed never reads a step's output, a result's detail, a note's body or the findings" $?

# FAILING EDIT: add a second setInterval to feed.js, or drop the clearInterval
# from close(). One timer per stream, cleared when the stream ends.
sets=$(sed 's|//.*||' "$FEED" | grep -c "setInterval(")
clears=$(body "$FEED" close | sed 's|//.*||' | grep -c "clearInterval(")
if [ "$sets" = "1" ] && [ "$clears" = "1" ]; then
    check "the feed has one interval, cleared in close()" 0
else
    check "the feed has one interval, cleared in close()" 1
fi

# FAILING EDIT: drop the `cancel()` handler from the ReadableStream, or the
# abort listener. The client's disconnect must reach close() both ways.
sed 's|//.*||' "$FEED" | grep -q "cancel() { close(); }" && sed 's|//.*||' "$FEED" | grep -q 'addEventListener("abort", close'
check "the stream's cancel and the request's abort both close it" $?

# FAILING EDIT: emit the "start" or "ask-write" step by widening SHOWN.
grep -q '^export const SHOWN = /\^(plan|draft|search-\\d+|step-\\d+)\$/;' "$FEED"
check "the shown steps are plan, the searches, the draft and a browser task's steps; bookkeeping stays out" $?

echo "the browser ledger (A89):"
step=$(body "$SRC" stepTask)
# FAILING EDIT: drop the allowlist loop from stepTask, or add "outline" to STEP_KEYS.
grep -q 'export const STEP_KEYS = \["id", "n", "kind", "label", "sentence", "answer", "reason"\];' "$BROWSER" \
    && echo "$step" | grep -q 'if (!STEP_KEYS.includes(key)) return problem(400, "bad_request", { key });' \
    && echo "$step" | grep -q 'raw.byteLength > STEP_BODY_MAX_BYTES'
check "a step is an allowlist of seven keys under 2 KB: page text has no key and no room" $?
# FAILING EDIT: store body.label as it came, without ledgerText.
[ "$(echo "$step" | sed 's|//.*||' | grep -c 'ledgerText(body\.')" = "3" ]
check "every string a step brings is cleaned of invisible characters and URL queries" $?
# FAILING EDIT: send the step's label in the event's payload.
echo "$step" | grep -q 'await instance.sendEvent({ type: "browser-step", payload: { n } });'
check "the instance is told only that a step was posted, never what it said" $?
# FAILING EDIT: let a step update the task's input.
! echo "$step" | sed 's|//.*||' | grep -qE 'input:|"input"|SET input'
check "no step writes the task's input: the mode can never change" $?
echo "$step" | grep -q 'if (kind === "approval" && input.mode !== "act") return problem(409, "read_only"'
check "an approval only in a task started to act" $?
echo "$step" | grep -q 'n > BROWSER_MAX_STEPS ? "step_limit" : elapsed > TYPES.browser.maxDurationMs ? "max_duration"'
check "the step bound and the working-time bound end the task from the route" $?

# FAILING EDIT: have guardedStep spread the whole `out` into the ledger entry.
guarded=$(body "$RUN" guardedStep | sed 's|//.*||')
echo "$guarded" | grep -q 'label: out.label.slice(0, 80)' && echo "$guarded" | grep -q 'queries: out.queries.slice(0, 20)' && ! echo "$guarded" | grep -q '\.\.\.out,' && ! echo "$guarded" | grep -q '\.\.\.out }'
check "the ledger takes a step's label and the plan's queries, cut, and nothing else of its output" $?

echo "a browser step's model call (A89 §11):"
askstep=$(body "$SRC" askStep | sed 's|//.*||')
# FAILING EDIT: drop `AND account_id = ?` or `AND calls < ?` from countCall, or add 'awaiting_approval' to its states.
count=$(body "$RUN" countCall | sed 's|//.*||' | tr -s ' \n' ' ')
echo "$count" | grep -q "UPDATE tasks SET calls = calls + 1 WHERE id = ? AND account_id = ? AND type = 'browser' AND state IN ('created', 'running', 'approved') AND calls < ? RETURNING"
check "a call is counted and checked in one statement: own account, a browser task, alive, not waiting for a yes, under the bound" $?
# FAILING EDIT: add "claude-opus-5-5" to ALLOWED_MODELS, or validate askStep against ALLOWED_MODELS.
allowed=$(awk '/^const ALLOWED_MODELS = new Set\(\[/,/^\]\);/' "$SRC")
stepmodels=$(awk '/^const STEP_MODELS = new Set\(\[/,/^\]\);/' "$SRC")
! echo "$allowed" | grep -q -- '-5-5"' && echo "$stepmodels" | grep -q '"claude-opus-5-5"' \
    && echo "$askstep" | grep -q 'validate(body, env, STEP_MODELS)' \
    && [ "$(strip "$SRC" | grep -c 'validate(body, env)')" = "1" ]
check "the 5.5 models are in STEP_MODELS alone, which only askStep validates against; the question's validate is unchanged" $?
# FAILING EDIT: call checkLimits or counterKeys from askStep.
! echo "$askstep" | grep -qE 'checkLimits|counterKeys|dayKey|hourKey|totalKey'
check "askStep never reads or writes the question counters" $?
# FAILING EDIT: drop the `plan.step_cap === undefined` guard.
echo "$askstep" | grep -q 'if (!plan || plan.step_cap === undefined || plan.step_cap === null) return problem(503, "not_provisioned");' \
    && echo "$askstep" | grep -q 'if (!counted) return refuseStepCall(env, task);' \
    && echo "$askstep" | grep -q 'if (n !== expected) return problem(409, "out_of_order"'
check "a call needs the plan's step_cap (fails closed), a counted row, and the next step" $?
# FAILING EDIT: route /v1/tasks/ask to the question handler, or read otto-task in the fetch handler.
grep -q 'if (url.pathname === "/v1/tasks/ask") return askStep(request, env, ctx, t0);' "$SRC" \
    && [ "$(strip "$SRC" | grep -c 'headers.get("otto-task")')" = "1" ] && echo "$askstep" | grep -q 'headers.get("otto-task")'
check "/v1/tasks/ask is its own route; otto-task is read in askStep alone" $?
# FAILING EDIT: replace `return new Response(upstream.body,` in askStep with a buffered read.
echo "$askstep" | grep -q 'return new Response(upstream.body, {' && ! echo "$askstep" | grep -qE 'upstream\.(text|json|arrayBuffer)\(|tee\('
check "the step's stream is passed through, never read" $?

echo "tasks — no words in the log:"

# FAILING EDIT: add `console.log(\`done: ${result.spoken}\`)` to finishTask.
# A row's type and state are logged freely; `row` itself is not in the list for that reason, and a
# line that interpolates row.input or row.result is caught by the field names.
WORDS='request|input|document|result|detail|question|spoken|payload|steps|answer|findings|body|text|messages|draft|query|queries|summary|context'
leaks=$( { for fn in $TASK_FUNCS safeTasksHeader markSeen; do body "$SRC" "$fn"; done; cat $PURE; } \
      | grep "console\." | grep -cE "\\\$\\{[^}]*\\b($WORDS)\\b" )
[ "$leaks" = "0" ]
check "no log line in the task routes or src/tasks/ interpolates a request, a result, a question or a row" $?

echo "tasks — one retention, one model:"

# FAILING EDIT: change any one of the four sevens.
grep -q "RETENTION_MS = 3 \* 24 \* 60 \* 60 \* 1000" "$RUN" \
    && [ "$(grep -c '_retention = "3 days"' "$TOML")" = "2" ] \
    && grep -A14 "research: {" "$REG" | grep -q 'retention: "3 days"'
check "the row, the binding's default_retention (both) and research's retention are all three days" $?

# FAILING EDIT: drop allowed_callers from WEB_SEARCH, or change the model.
grep -A14 "research: {" "$REG" | grep -q 'model: "claude-sonnet-5"' \
    && grep -A6 "WEB_SEARCH = {" "$RESEARCH" | grep -q 'allowed_callers: \["direct"\]' \
    && grep -A6 "WEB_SEARCH = {" "$RESEARCH" | grep -q "max_uses: 2,"
check "research runs on claude-sonnet-5 with direct, bounded web search" $?

# FAILING EDIT: raise FINDINGS_MAX_CHARS, the search step's maxTokens, put
# cents back in the question, or lower askAboveSearches.
grep -q "^const FINDINGS_MAX_CHARS = 4096;" "$RESEARCH" \
    && grep -A3 "tools: \[WEB_SEARCH\]," "$RESEARCH" | grep -q "maxTokens: 1024," \
    && grep -q 'This is a big one, about ${plan.queries.length} searches. Go ahead?' "$RESEARCH" \
    && ! grep 'ctx.ask(' "$RESEARCH" | grep -q 'cents' \
    && grep -A14 "research: {" "$REG" | grep -q "askAboveSearches: 15,"
check "a search step is bounded (1,024 output tokens, 4,096 characters to the draft); the question names searches, never cents, past fifteen" $?

# FAILING EDIT: compose an "otto-tasks" string in index.js.
composed=$(strip "$SRC" "$RUN" "$RESEARCH" "$REG" "$MODEL" | grep -c '"otto-tasks"')
[ "$composed" = "0" ] && grep -q '"otto-tasks": fields.join' "$SUMMARY"
check "the otto-tasks header is composed in summary.js and nowhere else" $?

# FAILING EDIT: restore the README's old sentence.
grep -q "never reads a response body on" README.md && grep -q "the question path" README.md
check "the README's body-reading claim names the question path" $?

echo
if [ "$fail" = "0" ]; then echo "TASK PATH OK"; else
    echo "TASK PATH FAILED — $fail check(s)"; fi
exit "$fail"
