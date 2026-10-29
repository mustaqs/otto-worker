/**
 * The per-account counters, in D1 (2026-10-29, option A), and the one KV
 * marker that keeps an over-cap question from ever reaching Anthropic.
 *
 * WHY D1. Workers KV's free plan allows 1,000 writes a day, and each
 * question wrote two counters: the relay would have stopped counting at
 * about fourteen active users. D1 allows 100,000 rows written a day, and an
 * increment here is one UPSERT, atomic, where KV's was a read and a write.
 *
 * WHY THE QUESTION DOES NOT WAIT FOR IT. A D1 round trip measured 83-127 ms
 * against KV's warm 4-6 ms, so the question path reads the counters WHILE
 * Anthropic works on the request (index.js) and decides before the first
 * byte is forwarded. What would have been a refusal aborts the upstream
 * request instead. The marker below makes that the rare case.
 *
 * THE MARKER. When a question reaches a cap — the last allowed one — the
 * relay writes `cap:<subject>` to KV with the window's reset time, and the
 * question path reads it beside the token, before the body is even parsed.
 * While it is present the account is refused at once, so an over-cap
 * question never starts a paid request. One write each time an account
 * reaches a cap; nothing for an account under it.
 */

/** The window a bucket names, for a moment. Pure. */
export function buckets(now) {
  const day = now.toISOString().slice(0, 10);          // YYYY-MM-DD
  const hour = now.toISOString().slice(0, 13);         // YYYY-MM-DDTHH
  return {
    day: `d:${day}`,
    hour: `h:${hour}`,
    total: "total",
    tool: `t:${day}`,
    task: `k:${day}`,
    step: `s:${day}`,
    dayEnds: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    hourEnds: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1),
  };
}

/** The statement that reads a subject's buckets, for a batch or on its own. */
export function countersQuery(env, subject, names) {
  return env.DB.prepare(
    `SELECT bucket, n FROM counters WHERE subject = ? AND bucket IN (${names.map(() => "?").join(", ")})`
  ).bind(subject, ...names);
}

/** Rows from countersQuery as { bucket: n }; a missing bucket is zero. */
export function countsFrom(result) {
  const counts = {};
  for (const row of (result && result.results) || []) counts[row.bucket] = Number(row.n) || 0;
  return counts;
}

/** A subject's buckets, read on their own. A failed read FAILS OPEN, as a counter write does: logged by class, read as zero. */
export async function readCounts(env, subject, names) {
  try { return countsFrom(await countersQuery(env, subject, names).all()); } catch (error) {
    console.error(`counters unreadable (${error && error.name ? error.name : "error"})`);
    return {};
  }
}

/**
 * One increment of each bucket, in one statement. `entries` are
 * [bucket, expiresAt, seed]: a row that does not exist yet starts at
 * seed + 1 (seed is zero but for a trial's total carried over from KV).
 * Logged by class and never thrown, as a KV write was: a counter that
 * cannot be written fails open.
 */
export async function bump(env, subject, entries, what) {
  try {
    await env.DB.prepare(
      `INSERT INTO counters (subject, bucket, n, expires_at) VALUES ${entries.map(() => "(?, ?, ?, ?)").join(", ")}
       ON CONFLICT (subject, bucket) DO UPDATE SET n = n + 1`
    ).bind(...entries.flatMap(([bucket, expiresAt, seed]) => [subject, bucket, (Number(seed) || 0) + 1, expiresAt])).run();
    return true;
  } catch (error) {
    console.error(`counter write failed (${what}): ${error && error.name ? error.name : "error"}`);
    return false;
  }
}

/** The hourly cleanup's half for counters: every window that has ended. */
export async function purgeCounters(env, now = Date.now()) {
  const result = await env.DB.prepare(`DELETE FROM counters WHERE expires_at IS NOT NULL AND expires_at < ?`).bind(now).run();
  const removed = (result && result.meta && result.meta.changes) || 0;
  console.log(`counter cleanup: ${removed} ended window(s) removed`);
  return removed;
}

// ------------------------------------------------------------------ marker

export const capKey = (subject) => `cap:${subject}`;

/**
 * The marker for a cap just reached, or null. Trial first, as the refusal
 * order is: it is the only cap that never resets. `counts` are the counts
 * INCLUDING the question that reached it.
 */
export function markerFor(account, counts, now) {
  const b = buckets(now);
  const onTrial = account.kind === "trial" && account.trialCap > 0;
  const base = { day: counts.day, hour: counts.hour, total: counts.total };
  if (onTrial && counts.total >= account.trialCap) return { code: "trial_exhausted", until: 0, ...base };
  if (account.dailyCap > 0 && counts.day >= account.dailyCap) return { code: "daily_limit", until: b.dayEnds, ...base };
  if (account.hourlyCap > 0 && counts.hour >= account.hourlyCap) return { code: "hourly_limit", until: b.hourEnds, ...base };
  return null;
}

/** Writes the marker, expiring with its window (KV's floor is sixty seconds). Never thrown. */
export async function writeMarker(env, subject, marker, now = Date.now()) {
  const options = marker.until ? { expiration: Math.ceil(Math.max(marker.until, now + 61_000) / 1000) } : undefined;
  try {
    await env.OTTO.put(capKey(subject), JSON.stringify(marker), options);
    console.log(`account capped (${marker.code})`);
    return true;
  } catch (error) {
    console.error(`kv write failed (cap marker): ${error && error.name ? error.name : "error"}`);
    return false;
  }
}

/**
 * Whether a stored marker still holds for this account now: inside its
 * window, and still at or over the cap the account has TODAY — a plan
 * raised since (a new token at sign-in carries the new caps) is not held
 * to the old one.
 */
export function markerHolds(marker, account, now) {
  if (!marker || typeof marker !== "object") return false;
  if (marker.code === "trial_exhausted") {
    return account.kind === "trial" && account.trialCap > 0 && Number(marker.total) >= account.trialCap;
  }
  if (!(Number(marker.until) > now.getTime())) return false;
  if (marker.code === "daily_limit") return account.dailyCap > 0 && Number(marker.day) >= account.dailyCap;
  if (marker.code === "hourly_limit") return account.hourlyCap > 0 && Number(marker.hour) >= account.hourlyCap;
  return false;
}
