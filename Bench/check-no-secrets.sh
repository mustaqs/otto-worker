#!/bin/bash
#
# Asserts that no secret-shaped string appears anywhere in this repository —
# in the working tree, and in every blob that has ever been committed.
#
# WHY THIS IS A CHECK AND NOT A README LINE. README.md tells a sceptical reader
# "there is no secret in this repository", and wrangler.toml says "NO SECRETS IN
# THIS FILE, ever". Both are claims made to users about a repository that is
# public on purpose. A claim made to users and verified by reading is the shape
# A62 already replaced once with grep: reading is what lets it drift.
#
# HISTORY IS THE POINT, NOT AN EXTRA. Deleting a leaked key in the next commit
# does not unpublish it — the blob stays in the history, reachable by hash and
# already cloned. A check that reads only the working tree would go green on a
# repository whose key is one `git show` away. So the scan covers both, and the
# history half is the half that cannot be fixed by editing a file.
#
#     exit 0   PASS     nothing secret-shaped, in the tree or in history
#     exit 1   FAIL     a match — treat any hit as live until proven otherwise
#     exit 2   NO DATA  the matcher or the scan is broken; nothing was checked
#
# NO DATA IS NOT A PASS, per check-plan-sync.sh. Two ways this check could go
# green while checking nothing — a pattern that no longer matches anything, and
# a file list that came back empty — and both are asserted against below.

set -u
cd "$(dirname "$0")/.." || exit 2

GREP=/usr/bin/grep

# ---------------------------------------------------------------------------
# The patterns, assembled from fragments.
#
# NOT COSMETIC. This script lives in the repository it scans, and it scans
# itself. A literal `sk-ant-...` written here — even as a comment or a
# self-test sample — would be a permanent red line, and the obvious fix for
# that (exclude this file from the scan) would carve a hole exactly where
# someone pasting a key is most likely to be working. Splitting the tokens
# means the file contains no string that matches, so it can be scanned like
# every other file.
# ---------------------------------------------------------------------------
A='sk''-ant-[A-Za-z0-9_-]{16,}'                       # Anthropic API key
S1='sb''_secret_[A-Za-z0-9_-]{16,}'                   # Supabase secret key (new format)
S2='ey''J[A-Za-z0-9_-]{8,}\.ey''J[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'  # any JWT (see below)
T1='sk''_live_[A-Za-z0-9]{16,}'                       # Stripe secret key, live
T2='sk''_test_[A-Za-z0-9]{16,}'                       # Stripe secret key, test
T3='rk''_live_[A-Za-z0-9]{16,}'                       # Stripe restricted key
T4='whs''ec_[A-Za-z0-9+/=_-]{16,}'                    # Stripe webhook signing secret
B='[Bb]earer[[:space:]]+[A-Za-z0-9._~+/=-]{20,}'      # a bearer token, spelled out

# WHY ALL JWTs AND NOT JUST SERVICE KEYS. A Supabase service key and an anon key
# are the same shape; only the decoded `role` claim tells them apart, and the
# expensive mistake is committing the one that bypasses row-level security. A
# shape test cannot distinguish them, so it flags both. There are zero JWTs in
# this repository today, which makes that free. If a genuine anon key ever needs
# to live here, add it as a named exception with the reason — do not widen this.
#
# WHY `Bearer <20+ chars>` DOES NOT FIRE ON OUR OWN CODE. src/index.js parses
# `/^Bearer\s+(\S+)$/` and test.mjs sends `Bearer ${token}` — an interpolation,
# not a literal. `$`, `{` and `}` are outside the character class on purpose, so
# a template placeholder is not a token but a pasted real one is.

PATTERN="$A|$S1|$S2|$T1|$T2|$T3|$T4|$B"

fail=0
check() {
    if [ "$2" = "0" ]; then printf '  ok   %s\n' "$1"
    else printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); fi
}

# ---------------------------------------------------------------------------
# SELF-TEST — the matcher must go red before it is allowed to say green.
#
# A19 collects checks that cannot go red. "Verified red once, by hand, when it
# was written" decays the moment a pattern is edited, so the red case runs on
# every invocation instead: one synthetic sample per pattern, assembled the same
# way, and a benign line that must NOT match so this cannot pass by matching
# everything. A miss here is exit 2 — the scan below would be meaningless.
# ---------------------------------------------------------------------------
samples() {
    printf '%s\n' \
        "key = \"sk""-ant-api03-0123456789abcdefghij\"" \
        "key = \"sb""_secret_0123456789abcdefghij\"" \
        "jwt = \"ey""JhbGciOiJIUzI1NiJ9.ey""Jyb2xlIjoic2VydmljZSJ9.0123456789ab\"" \
        "key = \"sk""_live_0123456789abcdefghij\"" \
        "key = \"sk""_test_0123456789abcdefghij\"" \
        "key = \"rk""_live_0123456789abcdefghij\"" \
        "sec = \"whs""ec_0123456789abcdefghij\"" \
        "authorization: Bear""er 0123456789abcdefghijklmno"
}
expected=8
got=$(samples | $GREP -cE "$PATTERN")
if [ "$got" != "$expected" ]; then
    echo ""
    echo "  ############################################"
    echo "  #  NO DATA — NOTHING WAS CHECKED           #"
    echo "  #  This is NOT a pass.                     #"
    echo "  ############################################"
    echo "  The matcher failed its own red case: $got of $expected samples matched."
    echo "  A pattern was edited and no longer detects what it names."
    exit 2
fi

# The benign case. Without this, a pattern degraded to `.` would sail through
# the block above with a perfect score.
benign='const token = bearer(request); // Bearer ${token}, MAX_OUTPUT_TOKENS'
if printf '%s\n' "$benign" | $GREP -qE "$PATTERN"; then
    echo "  matcher matches a benign line — it would flag everything."
    exit 2
fi

echo "secret scan (self-test: $expected/$expected patterns red, benign line clean):"

# ---------------------------------------------------------------------------
# SCAN 1 — the working tree.
#
# Tracked files AND untracked-but-not-ignored ones. An untracked secret file is
# one `git add -A` away from being history, which is the point at which it stops
# being fixable. Ignored paths (.dev.vars, .wrangler/) are excluded because they
# are where secrets are SUPPOSED to live; --exclude-standard is what makes that
# distinction, and .gitignore is therefore load-bearing for this check.
# ---------------------------------------------------------------------------
files=$(git ls-files --cached --others --exclude-standard)
count=$(printf '%s\n' "$files" | $GREP -c .)
if [ -z "$files" ] || [ "$count" -lt 5 ]; then
    echo "  ############################################"
    echo "  #  NO DATA — NOTHING WAS CHECKED           #"
    echo "  #  This is NOT a pass.                     #"
    echo "  ############################################"
    echo "  git listed $count file(s) to scan. Not a repository, or an empty one."
    exit 2
fi

hits=$(printf '%s\n' "$files" | while IFS= read -r f; do
    [ -f "$f" ] || continue
    $GREP -aInE "$PATTERN" "$f" /dev/null
done)
if [ -n "$hits" ]; then
    check "working tree ($count files) has no secret-shaped string" 1
    printf '%s\n' "$hits" | /usr/bin/sed 's/^/       /' | /usr/bin/head -20
else
    check "working tree ($count files) has no secret-shaped string" 0
fi

# ---------------------------------------------------------------------------
# SCAN 2 — every blob the object database holds.
#
# Not `git log -p`, and not the tip of each branch. A62's rule from A60: the
# artifact you inspect has to be the one you are acting on, and a truncated view
# of history is not the history. So the list is every blob reachable from every
# ref, plus every blob named by the reflog, plus dangling ones — a commit that
# was amended away still has its blob in the clone that fetched it first.
# ---------------------------------------------------------------------------
blobs=$( {
    git rev-list --objects --all 2>/dev/null \
        | git cat-file --batch-check='%(objecttype) %(objectname) %(rest)' 2>/dev/null \
        | /usr/bin/awk '$1=="blob" {print $2 " " $3}'
    git reflog --all --format='%H' 2>/dev/null | while read -r c; do
        git ls-tree -r "$c" 2>/dev/null | /usr/bin/awk '$2=="blob" {print $3 " " $4}'
    done
    git fsck --dangling 2>/dev/null | /usr/bin/awk '$2=="blob" {print $3 " (dangling)"}'
} | /usr/bin/sort -u)

nblobs=$(printf '%s\n' "$blobs" | $GREP -c .)
if [ -z "$blobs" ] || [ "$nblobs" -lt "$count" ]; then
    echo "  ############################################"
    echo "  #  NO DATA — NOTHING WAS CHECKED           #"
    echo "  #  This is NOT a pass.                     #"
    echo "  ############################################"
    echo "  history walk found $nblobs blob(s), fewer than the $count file(s) in"
    echo "  the tree. The enumeration is broken; it is not that history is empty."
    exit 2
fi

# `read -r oid path` on the DEFAULT IFS, deliberately. An earlier version wrote
# `IFS= read -r oid path`, copied from the file loop above where clearing IFS is
# right because a filename must survive whole. Here it is wrong: with no field
# separator the entire line lands in $oid, `git cat-file blob "<sha> <path>"` is
# a malformed argument, every read fails, and the scan reports a clean history
# because nothing came back. It was caught by a red test that stayed green.
#
# That is A19's second shape — a check that reads silence as success — and the
# fix is not to write the line correctly but to make the silent version loud.
# $read counts blobs that actually yielded bytes; if it does not reach every
# blob, the result is NO DATA rather than a pass.
read=0
histhits=$(printf '%s\n' "$blobs" | while read -r oid path; do
    out=$(git cat-file blob "$oid" 2>/dev/null)
    [ -z "$out" ] && { printf 'UNREAD %s %s\n' "$oid" "$path"; continue; }
    hit=$(printf '%s\n' "$out" | $GREP -aInE "$PATTERN")
    [ -n "$hit" ] && printf 'HIT %s %s\n%s\n' "$oid" "$path" "$hit"
done)
unread=$(printf '%s\n' "$histhits" | $GREP -c '^UNREAD ' )
if [ "$unread" != "0" ]; then
    echo "  ############################################"
    echo "  #  NO DATA — NOTHING WAS CHECKED           #"
    echo "  #  This is NOT a pass.                     #"
    echo "  ############################################"
    echo "  $unread of $nblobs blob(s) could not be read, so they were not scanned."
    printf '%s\n' "$histhits" | $GREP '^UNREAD ' | /usr/bin/sed 's/^/  /' | /usr/bin/head -5
    exit 2
fi
if [ -n "$histhits" ]; then
    check "history ($nblobs blobs, all refs + reflog + dangling) is clean" 1
    printf '%s\n' "$histhits" | /usr/bin/sed 's/^/       /' | /usr/bin/head -20
    echo ""
    echo "  A HIT HERE IS NOT FIXED BY A COMMIT. The blob is already published."
    echo "  Rotate the credential first — that is the only step that takes effect"
    echo "  immediately — then rewrite history if it is still worth doing."
else
    check "history ($nblobs blobs, all refs + reflog + dangling) is clean" 0
fi

echo
if [ "$fail" = "0" ]; then echo "NO SECRETS OK"; else
    echo "SECRET SCAN FAILED — $fail check(s)"; fi
exit "$fail"
