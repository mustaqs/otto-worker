#!/bin/bash
#
# Asserts that the question path touches KV and Anthropic, and nothing else.
#
# WHY THIS IS A CHECK AND NOT A COMMENT. "A question touches the Worker, KV and
# Anthropic" is the sentence SPEC.md A26 makes to users about what Otto talks
# to. It is also the constraint most likely to erode: adding a D1 read to
# loadAccount would be one line, would work, would pass every test, and would
# quietly put a second store on the path every question takes — costing latency
# on the hot path and making the privacy claim false.
#
# Same treatment as the app's Bench/check-monitors.sh: a claim that is verified
# by grep rather than by reading, because reading is what lets it drift.
#
# Every check here has been verified to go red — see the FAILING EDIT comments.

set -u
cd "$(dirname "$0")/.." || exit 2
SRC=src/index.js

fail=0
check() {
    if [ "$2" = "0" ]; then printf '  ok   %s\n' "$1"
    else printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); fi
}

[ -f "$SRC" ] || { echo "FAIL: no $SRC"; exit 2; }

# The functions the question path actually calls, and nothing else. Named
# explicitly rather than traced, because a wrong trace fails open.
PATH_FUNCS="loadAccount checkLimits validate"

# Extract one function body by brace depth.
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

echo "question path isolation:"

# FAILING EDIT: add `await env.DB.prepare("SELECT 1").first()` to loadAccount.
for fn in $PATH_FUNCS; do
    text=$(body "$fn")
    if [ -z "$text" ]; then
        check "$fn — NOT FOUND, so nothing was checked" 1
        continue
    fi
    case "$text" in
        *env.DB*|*d1*|*D1Database*|*prepare\(*)
            check "$fn does not touch D1" 1 ;;
        *)  check "$fn does not touch D1" 0 ;;
    esac
    case "$text" in
        *supabase*|*SUPABASE*|*auth/v1*)
            check "$fn does not touch Supabase" 1 ;;
        *)  check "$fn does not touch Supabase" 0 ;;
    esac
    case "$text" in
        *stripe*|*STRIPE*) check "$fn does not touch Stripe" 1 ;;
        *)                 check "$fn does not touch Stripe" 0 ;;
    esac
done

# The only fetch reachable from a question is the upstream model call. A second
# one would be a second network hop on the path A26 measures at ~21ms.
fetches=$(for fn in $PATH_FUNCS; do body "$fn"; done | grep -c "fetch(")
[ "$fetches" = "0" ]
check "no fetch() inside the question path's helpers" $?

# AN EXACT SET AGAINST A DECLARED ALLOWLIST, not a search for known-bad names.
# A60's rule: a presence test cannot see something you did not think to look
# for, and a new binding is exactly that. Config vars from [vars] are listed
# here because they are read at request time and are not stores; adding one
# means adding it here in the same change, which is the point.
#
# FAILING EDIT: change env.OTTO to env.DB in checkLimits, or add any binding.
ALLOWED_BINDINGS="env.MAX_IMAGES env.MAX_OUTPUT_TOKENS env.OTTO"
seen=$(for fn in $PATH_FUNCS; do body "$fn"; done \
       | grep -o "env\.[A-Za-z_][A-Za-z0-9_]*" | sort -u)
expected=$(printf '%s\n' $ALLOWED_BINDINGS | sort)
if [ -z "$seen" ]; then
    check "no bindings read at all — the extraction is broken" 1
elif [ "$seen" = "$expected" ]; then
    check "the path reads only the declared bindings" 0
else
    check "the path reads a binding that is not declared" 1
    printf '       unexpected: %s\n' "$(comm -23 <(echo "$seen") <(echo "$expected") | tr '\n' ' ')"
    printf '       missing:    %s\n' "$(comm -13 <(echo "$seen") <(echo "$expected") | tr '\n' ' ')"
fi

# Registration writes D1, and must NOT be mistaken for part of the path. This
# asserts the separation is real rather than assumed: if registerDevice ever
# stops touching D1, someone has moved entitlement writes somewhere worse.
case "$(body registerDevice)" in
    *env.DB*) check "registration writes D1, off the question path" 0 ;;
    *)        check "registration no longer writes D1 — where did it move?" 1 ;;
esac

echo "sign-in isolation (A70):"

# THE KEY HAS EXACTLY ONE READER, and it is the function that talks to
# Supabase. A second reader is a second place the key can leak.
# FAILING EDIT: read env.SUPABASE_SECRET_KEY in signInStart.
readers=$(grep -c "env\.SUPABASE_SECRET_KEY" "$SRC")
inside=$(body supabase | grep -c "env\.SUPABASE_SECRET_KEY")
if [ "$readers" = "1" ] && [ "$inside" = "1" ]; then
    check "the secret key is read in exactly one function, supabase()" 0
else
    check "the secret key is read in exactly one function, supabase()" 1
    printf '       readers in file: %s, inside supabase(): %s\n' "$readers" "$inside"
fi

# SUPABASE IS CALLED FROM THE TWO SIGN-IN ROUTES AND NOWHERE ELSE. Counted
# outside their bodies rather than searched for in the question path, so a
# call added to registration — or anywhere new — is caught too.
# FAILING EDIT: call supabase(env, ...) from registerDevice.
total=$(grep -v "function supabase(" "$SRC" | grep -c "supabase(env")
allowed=$(for fn in signInStart signInVerify; do body "$fn"; done | grep -c "supabase(env")
if [ "$total" -gt 0 ] && [ "$total" = "$allowed" ]; then
    check "supabase() is called only from signInStart and signInVerify" 0
else
    check "supabase() is called only from signInStart and signInVerify" 1
    printf '       calls in file: %s, inside the two routes: %s\n' "$total" "$allowed"
fi

# NEVER THE ADDRESS, THE CODE, OR A TOKEN IN A LOG LINE. Asserted on the
# console calls inside the sign-in functions, including the helper that holds
# the address longest.
# FAILING EDIT: add `console.error(\`failed for ${email}\`)` to signInStart.
leaks=$(for fn in signInStart signInVerify findOrCreateAccount supabase authenticate; do body "$fn"; done \
        | grep "console\." | grep -cE '\$\{(email|code|token|user\.email|auth\.token|body)')
[ "$leaks" = "0" ]
check "no log line in the sign-in functions interpolates an address, code or token" $?

echo
if [ "$fail" = "0" ]; then echo "QUESTION PATH OK"; else
    echo "QUESTION PATH FAILED — $fail check(s)"; fi
exit "$fail"
