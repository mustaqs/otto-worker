#!/bin/bash
#
# Asserts what the task runtime may and may not touch (SPEC.md A82).
#
# Four claims, each verified by grep because reading is what lets them drift:
#   1. The key has exactly two readers: the question path's pass-through in
#      src/index.js and anthropic() in src/tasks/model.js. No third.
#   2. The question path reads the task summary and never writes it, never
#      names the Workflow binding, and never touches D1 for a task.
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
SUMMARY=src/tasks/summary.js
MAIN=src/main.js
TOML=wrangler.toml
PURE="$RUN $MODEL $REG $RESEARCH $SUMMARY"

fail=0
check() {
    if [ "$2" = "0" ]; then printf '  ok   %s\n' "$1"
    else printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); fi
}

for f in $SRC $RUN $MODEL $WF $REG $RESEARCH $SUMMARY $MAIN $TOML; do
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

# FAILING EDIT: read env.ANTHROPIC_API_KEY in runResearch (research.js).
in_index=$(grep -c "env\.ANTHROPIC_API_KEY" "$SRC")
in_tasks=$(cat $RUN $MODEL $WF $REG $RESEARCH $SUMMARY | grep -c "env\.ANTHROPIC_API_KEY")
in_fn=$(body "$MODEL" anthropic | grep -c "env\.ANTHROPIC_API_KEY")
if [ "$in_index" = "1" ] && [ "$in_tasks" = "1" ] && [ "$in_fn" = "1" ]; then
    check "the key is read once in index.js and once under src/tasks/, inside anthropic()" 0
else
    check "the key is read once in index.js and once under src/tasks/, inside anthropic()" 1
    printf '       index.js: %s, src/tasks: %s, inside anthropic(): %s\n' "$in_index" "$in_tasks" "$in_fn"
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

# FAILING EDIT: add `env.OTTO.put(tasksKey, "x")` to checkLimits's commit.
puts=$(body "$SRC" checkLimits | sed 's|//.*||' | grep "put(" | grep -c "tasksKey")
[ "$puts" = "0" ]
check "checkLimits reads the task summary and never writes it" $?

# FAILING EDIT: write a second `tasks:` template literal anywhere in index.js.
literals=$(strip "$SRC" | grep -c '`tasks:')
inside=$(body "$SRC" counterKeys | sed 's|//.*||' | grep -c '`tasks:')
if [ "$literals" = "1" ] && [ "$inside" = "1" ]; then
    check "the one tasks: key literal in index.js is in counterKeys" 0
else
    check "the one tasks: key literal in index.js is in counterKeys" 1
fi

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

# FAILING EDIT: remove `timeout:` from the waitForEvent call, or call waitForEvent in research.js.
waits=$(cat $RUN $REG $RESEARCH $SUMMARY $MODEL | sed 's|//.*||' | grep -c "waitForEvent(")
in_ask=$(body "$RUN" askUser | sed 's|//.*||' | grep "waitForEvent(" | grep -c "timeout:")
if [ "$waits" = "1" ] && [ "$in_ask" = "1" ]; then
    check "waitForEvent has one caller, askUser, and it passes a timeout" 0
else
    check "waitForEvent has one caller, askUser, and it passes a timeout" 1
fi

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

TASK_FUNCS="createTask approveTask cancelTask takeTask deleteTask listTasks taskFromBody"
# FAILING EDIT: replace authenticateAccount with authenticate in createTask.
for fn in createTask listTasks taskFromBody; do
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
put_line=$(echo "$create" | grep -n 'put(taskDayKey' | head -1 | cut -d: -f1)
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
grep -q 'CREATE_KEYS = \["type", "request", "context", "document", "now", "tz"\]' "$REG" \
    && echo "$create" | grep -q "CREATE_KEYS.includes(key)"
check "the create body is an allowlist of six keys, so an image has no name to arrive under" $?

# FAILING EDIT: move `deleteInstance` above `markSeen` in takeTask.
take=$(body "$SRC" takeTask)
seen_line=$(echo "$take" | grep -n "markSeen(" | head -1 | cut -d: -f1)
del_line=$(echo "$take" | grep -n "deleteInstance(" | head -1 | cut -d: -f1)
if [ -n "$seen_line" ] && [ -n "$del_line" ] && [ "$seen_line" -lt "$del_line" ]; then
    check "takeTask marks the row seen before it deletes the instance" 0
else
    check "takeTask marks the row seen before it deletes the instance" 1
fi

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
grep -q "RETENTION_MS = 7 \* 24 \* 60 \* 60 \* 1000" "$RUN" \
    && [ "$(grep -c '_retention = "7 days"' "$TOML")" = "2" ] \
    && grep -A14 "research: {" "$REG" | grep -q 'retention: "7 days"'
check "the row, the binding's default_retention (both) and research's retention are all seven days" $?

# FAILING EDIT: drop allowed_callers from WEB_SEARCH, or change the model.
grep -A14 "research: {" "$REG" | grep -q 'model: "claude-sonnet-5"' \
    && grep -A6 "WEB_SEARCH = {" "$RESEARCH" | grep -q 'allowed_callers: \["direct"\]' \
    && grep -A6 "WEB_SEARCH = {" "$RESEARCH" | grep -q "max_uses:"
check "research runs on claude-sonnet-5 with direct, bounded web search" $?

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
