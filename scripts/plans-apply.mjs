#!/usr/bin/env node
/**
 * Rewrites every KV token record so its caps match its plan's row in D1.
 *
 * WHY THIS EXISTS. The question path reads caps out of the KV record and never
 * looks a plan up, because a D1 read on that path is forbidden. That
 * denormalisation is correct and it has one consequence: changing a cap in D1
 * does NOT reach records already written. A row update that silently does
 * nothing is the KV-and-D1 divergence shape, and it would present as "I raised
 * the cap and nothing happened".
 *
 * So a cap change is TWO steps, and Bench/check-plan-sync.sh fails until the
 * second one has run:
 *
 *     wrangler d1 execute otto --command "UPDATE plans SET daily_cap=..."
 *     npm run plans:apply
 *
 * Prints no token, ever — not on the happy path and not in an error. A token is
 * a credential and this output is the kind of thing that gets pasted.
 */
import { execFileSync } from "node:child_process";

const wrangler = (args) =>
  execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const redact = (token) => `token:…${String(token).slice(-4)}`;

function plans() {
  const raw = wrangler(["d1", "execute", "otto", "--remote", "--json",
                        "--command", "SELECT name, daily_cap, hourly_cap, trial_cap FROM plans"]);
  const rows = JSON.parse(raw)[0]?.results ?? [];
  return new Map(rows.map((r) => [r.name, r]));
}

function keys() {
  const raw = wrangler(["kv", "key", "list", "--binding", "OTTO", "--remote"]);
  return JSON.parse(raw).map((k) => k.name).filter((n) => n.startsWith("token:"));
}

const byPlan = plans();
let changed = 0, skipped = 0;

for (const key of keys()) {
  const raw = wrangler(["kv", "key", "get", key, "--binding", "OTTO", "--remote"]);
  let record;
  try { record = JSON.parse(raw); } catch { console.error(`unparseable: ${redact(key)}`); continue; }

  // v1 records predate plans and are left exactly as they are. They belong to
  // beta testers whose caps were set by hand; adopting them into a plan would
  // change limits nobody asked to change.
  if (record.v !== 2) { skipped++; continue; }

  const plan = byPlan.get(record.plan);
  if (!plan) { console.error(`unknown plan '${record.plan}' on ${redact(key)}`); continue; }

  if (record.dailyCap === plan.daily_cap &&
      record.hourlyCap === plan.hourly_cap &&
      record.trialCap === plan.trial_cap) continue;

  const updated = { ...record, dailyCap: plan.daily_cap,
                    hourlyCap: plan.hourly_cap, trialCap: plan.trial_cap };
  wrangler(["kv", "key", "put", key, JSON.stringify(updated), "--binding", "OTTO", "--remote"]);
  console.log(`updated ${redact(key)} -> ${record.plan}`);
  changed++;
}

console.log(`\n${changed} record(s) updated, ${skipped} v1 record(s) left alone.`);
