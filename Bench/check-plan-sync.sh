#!/bin/bash
#
# Asserts no KV token record disagrees with its plan's row in D1.
#
# WHY: the question path reads caps from KV and never looks a plan up, so a cap
# raised in D1 reaches nobody until `npm run plans:apply` runs. This is the check
# that turns "the row update silently did nothing" into a red line.
#
#     exit 0   PASS
#     exit 1   FAIL   at least one record disagrees — run npm run plans:apply
#     exit 2   NO DATA  wrangler cannot reach the account; nothing was checked
#
# NO DATA IS NOT A PASS. Without credentials this can check nothing, and saying
# so is the difference between this and a check that goes green on an empty set.

set -u
cd "$(dirname "$0")/.." || exit 2

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo ""
  echo "  ############################################"
  echo "  #  NO DATA — NOTHING WAS CHECKED           #"
  echo "  #  This is NOT a pass.                     #"
  echo "  ############################################"
  echo "  wrangler is not authenticated. Run: npx wrangler login"
  exit 2
fi

echo "plan sync (D1 -> KV):"
out=$(node - <<'JS' 2>&1
import("node:child_process").then(async ({ execFileSync }) => {
  const w = (a) => execFileSync("npx", ["wrangler", ...a], { encoding: "utf8" });
  const rows = JSON.parse(w(["d1","execute","otto","--remote","--json","--command",
    "SELECT name, daily_cap, hourly_cap, trial_cap FROM plans"]))[0]?.results ?? [];
  const byPlan = new Map(rows.map(r => [r.name, r]));
  const keys = JSON.parse(w(["kv","key","list","--binding","OTTO","--remote"]))
    .map(k => k.name).filter(n => n.startsWith("token:"));
  let bad = 0, seen = 0;
  for (const key of keys) {
    let rec; try { rec = JSON.parse(w(["kv","key","get",key,"--binding","OTTO","--remote"])); }
    catch { continue; }
    if (rec.v !== 2) continue;
    seen++;
    const p = byPlan.get(rec.plan);
    if (!p) { console.log(`UNKNOWN_PLAN ${rec.plan}`); bad++; continue; }
    if (rec.dailyCap !== p.daily_cap || rec.hourlyCap !== p.hourly_cap
        || rec.trialCap !== p.trial_cap) {
      // Never the token: the last four characters are enough to find a row.
      console.log(`DRIFT plan=${rec.plan} token=…${key.slice(-4)}`);
      bad++;
    }
  }
  console.log(`CHECKED ${seen} v2 record(s), ${bad} disagreeing`);
});
JS
)
status=$?

# THE COMPARISON MUST HAVE ACTUALLY RUN. A crashed walk prints an error and no
# CHECKED line, and an earlier version of this script fell straight through it
# to "PLAN SYNC OK" — a green result from a program that had thrown. Requiring
# the summary line is the guard: silence is never a pass.
case "$out" in
  *CHECKED*) ;;
  *)
    echo "$out" | sed 's/^/  /' | tail -12
    echo ""
    echo "  ############################################"
    echo "  #  NO DATA — NOTHING WAS CHECKED           #"
    echo "  #  This is NOT a pass.                     #"
    echo "  ############################################"
    echo "  The comparison did not complete (node exit $status). Usually this"
    echo "  means the D1 database or KV namespace does not exist yet:"
    echo "    npx wrangler d1 create otto"
    echo "    npx wrangler d1 execute otto --remote --file migrations/0001_accounts.sql"
    exit 2 ;;
esac

echo "$out" | sed 's/^/  /'
case "$out" in
  *DRIFT*|*UNKNOWN_PLAN*)
    echo
    echo "  A cap was changed in D1 and never applied. Run: npm run plans:apply"
    exit 1 ;;
esac
echo
echo "PLAN SYNC OK"
