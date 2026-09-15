#!/bin/bash
#
# Asserts what the connected-apps routes may and may not touch (SPEC.md A76).
#
# Three claims, each verified by grep because reading is what lets them drift:
#   1. The Composio key and the webhook secret each have exactly one reader.
#   2. The tool routes never reach Supabase, and the webhook verifies its
#      signature before it parses its body.
#   3. src/tools.js is pure — no fetch, no env, no imports — and no log line in
#      the tool routes interpolates arguments, results, a token or a body.
#
# check-question-path.sh still guards the question path itself; this file is
# about the new routes and says nothing about /v1/ask.
#
# Every check has been verified to go red — see the FAILING EDIT comments.

set -u
cd "$(dirname "$0")/.." || exit 2
SRC=src/index.js
PURE=src/tools.js

fail=0
check() {
    if [ "$2" = "0" ]; then printf '  ok   %s\n' "$1"
    else printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); fi
}

[ -f "$SRC" ] || { echo "FAIL: no $SRC"; exit 2; }
[ -f "$PURE" ] || { echo "FAIL: no $PURE"; exit 2; }

body() {
    awk -v name="$1" '
        index($0, "function " name "(") && !started { started = 1 }
        started {
            print
            n = gsub(/\{/, "{"); m = gsub(/\}/, "}")
            depth += n - m
            if (opened || n > 0) { opened = 1; if (depth <= 0) exit }
        }
    ' "$SRC"
}

echo "connected apps — secrets:"

# FAILING EDIT: read env.COMPOSIO_API_KEY in runTool.
readers=$(grep -c "env\.COMPOSIO_API_KEY" "$SRC")
inside=$(body composio | grep -c "env\.COMPOSIO_API_KEY")
if [ "$readers" = "1" ] && [ "$inside" = "1" ]; then
    check "the Composio key is read in exactly one function, composio()" 0
else
    check "the Composio key is read in exactly one function, composio()" 1
    printf '       readers in file: %s, inside composio(): %s\n' "$readers" "$inside"
fi

# FAILING EDIT: read env.COMPOSIO_WEBHOOK_SECRET in integrationsStatus.
readers=$(grep -c "env\.COMPOSIO_WEBHOOK_SECRET" "$SRC")
inside=$(body integrationsWebhook | grep -c "env\.COMPOSIO_WEBHOOK_SECRET")
if [ "$readers" = "1" ] && [ "$inside" = "1" ]; then
    check "the webhook secret is read in exactly one function, integrationsWebhook()" 0
else
    check "the webhook secret is read in exactly one function, integrationsWebhook()" 1
fi

# FAILING EDIT: add `fetch(\`${COMPOSIO}/x\`)` to runTool.
total=$(grep -c '\${COMPOSIO}' "$SRC")
inside=$(body composio | grep -c '\${COMPOSIO}')
if [ "$total" = "1" ] && [ "$inside" = "1" ]; then
    check "the Composio base URL is used only inside composio()" 0
else
    check "the Composio base URL is used only inside composio()" 1
    printf '       uses in file: %s, inside composio(): %s\n' "$total" "$inside"
fi

echo "connected apps — routes:"

TOOL_FUNCS="runTool integrationsStatus integrationsLink integrationsCallback integrationsUnlink integrationsWebhook activateIntegration connectDefaults"

# FAILING EDIT: call supabase(env, ...) from runTool.
for fn in $TOOL_FUNCS; do
    text=$(body "$fn")
    if [ -z "$text" ]; then check "$fn — NOT FOUND, so nothing was checked" 1; continue; fi
    case "$text" in
        *supabase*|*SUPABASE*|*auth/v1*) check "$fn does not touch Supabase" 1 ;;
        *)                               check "$fn does not touch Supabase" 0 ;;
    esac
done

# Verified before parsed: the signature check's line number precedes the parse.
# FAILING EDIT: move `JSON.parse(raw)` above `verifyWebhookSignature(` in the webhook.
verify_line=$(body integrationsWebhook | grep -n "verifyWebhookSignature(" | head -1 | cut -d: -f1)
parse_line=$(body integrationsWebhook | grep -n "JSON.parse(raw)" | head -1 | cut -d: -f1)
if [ -n "$verify_line" ] && [ -n "$parse_line" ] && [ "$verify_line" -lt "$parse_line" ]; then
    check "the webhook verifies the signature before it parses the body" 0
else
    check "the webhook verifies the signature before it parses the body" 1
fi

# A trial device has no account and must be refused before any lookup.
# FAILING EDIT: replace authenticateAccount with authenticate in runTool.
case "$(body runTool)" in
    *authenticateAccount*) check "runTool requires an account behind the bearer" 0 ;;
    *)                     check "runTool requires an account behind the bearer" 1 ;;
esac

# The question path is untouched: its allowlist is asserted by the other
# script; here only that its three functions never mention the new table.
# FAILING EDIT: add `integrations` to a comment-free line of checkLimits.
for fn in loadAccount checkLimits validate; do
    hits=$(body "$fn" | sed 's|//.*||' | grep -c "integrations")
    [ "$hits" = "0" ]
    check "$fn never mentions the integrations table" $?
done

echo "connected apps — a failure is classified on the number (A58, A77):"
# FAILING EDIT: derive `reason` from a regex over reply.json.error in runTool.
body runTool | grep -q 'reply.json.data.status_code'
check "runTool reads the app's status_code for the reason" $?
! body runTool | sed 's|//.*||' | grep -E 'reason' | grep -qE 'error\)|message|test\(|match\('
check "and never the free-text error" $?

echo "connected apps — no words in the log:"

# FAILING EDIT: add `console.log(\`ran ${tool} with ${JSON.stringify(args)}\`)` to runTool.
leaks=$(for fn in $TOOL_FUNCS composio; do body "$fn"; done \
        | grep "console\." | grep -cE '\$\{[^}]*\b(args|input|result|body|raw|token|event|reply\.json|defaults|replies)\b')
[ "$leaks" = "0" ]
check "no log line in the tool routes interpolates arguments, a result, a body or a token" $?

echo "connected apps — the mapping is pure:"

# FAILING EDIT: add `fetch(` or `env.` or `import` to src/tools.js.
[ "$(grep -c 'fetch(' "$PURE")" = "0" ];       check "tools.js makes no request" $?
[ "$(grep -c 'env\.' "$PURE")" = "0" ];        check "tools.js reads no binding" $?
[ "$(grep -c '^import' "$PURE")" = "0" ];      check "tools.js imports nothing" $?
[ "$(grep -c 'console\.' "$PURE")" = "0" ];    check "tools.js logs nothing" $?

echo
if [ "$fail" = "0" ]; then echo "TOOL PATH OK"; else
    echo "TOOL PATH FAILED — $fail check(s)"; fi
exit "$fail"
