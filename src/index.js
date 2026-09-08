/**
 * Otto's relay to the Anthropic Messages API.
 *
 * WHY THIS EXISTS: so the API key is a server-side secret and never ships in
 * the app. Otto sends a per-user bearer token; this validates it, checks the
 * user's limits, and forwards the request with the real key.
 *
 * WHAT IT DOES NOT DO, and this is the load-bearing part: it does not read,
 * store, or log the contents of a request or a response. Nothing about a
 * screenshot or a question is written anywhere. The source is published so that
 * claim can be read rather than taken on trust — though published source is not
 * proof of deployed source, and Otto's privacy page says so.
 */

const ANTHROPIC = "https://api.anthropic.com/v1/messages";

/**
 * Set the first time this isolate handles a request. Workers spin down when
 * idle, and a cold start is indistinguishable from Anthropic being slow when
 * measured from the app. This is how they are told apart.
 */
let isolateWarm = false;

/** Models Otto is allowed to ask for. A leaked token cannot pick another. */
const ALLOWED_MODELS = new Set([
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
]);

export default {
  async fetch(request, env, ctx) {
    const t0 = Date.now();
    const cold = !isolateWarm;
    isolateWarm = true;

    if (request.method !== "POST") return problem(405, "method_not_allowed");
    const url = new URL(request.url);

    // Registration is a separate route on purpose, and it is the ONLY other one.
    // Everything the question path needs is below; nothing it calls reaches D1
    // or any identity provider. Bench/check-question-path.sh asserts that by
    // grep rather than by reading, in the style of the app's check-monitors.sh.
    if (url.pathname === "/v1/device") return registerDevice(request, env);

    if (url.pathname !== "/v1/ask") return problem(404, "not_found");

    const token = bearer(request);
    if (!token) return problem(401, "missing_token");

    // Broken into parts because "auth costs 600ms" is not actionable: a token
    // read, two counter reads and two counter writes are three round trips with
    // very different costs, and optimising the wrong one is how A20 went.
    const timing = { tokenRead: 0, counterRead: 0, counterWrite: 0 };

    const tToken = Date.now();
    const account = await loadAccount(env, token);
    timing.tokenRead = Date.now() - tToken;

    if (!account) return problem(401, "unknown_token");
    if (!account.active) return problem(403, "revoked");

    // Checked before the upstream call, so a failure downstream still counts and
    // does not hand out a free retry. The INCREMENT is deferred — see below.
    const gate = await checkLimits(env, account, timing);
    if (gate.refused) return gate.refused;

    /*
     * The counter write costs ~290ms and is deliberately OFF the critical path.
     *
     * Measured: kvwrite was a stable ~290ms of a ~600ms auth phase, while reads
     * ranged 4-158ms depending on edge cache warmth. Nothing downstream depends
     * on the write having landed, so waiting for it spent a third of a second
     * on every question to make a counter durable a moment sooner.
     *
     * Scheduled here rather than after the upstream call, so a request that
     * fails at Anthropic still counts. What is given up: a write that fails is
     * lost, and repeated failures would accrue free requests. That is a
     * deliberate reliability trade, so it is logged rather than swallowed.
     */
    defer(ctx, gate.commit(), "counter increment");
    const afterKV = Date.now();

    let body;
    try {
      body = await request.json();
    } catch {
      return problem(400, "malformed_json");
    }

    const rejection = validate(body, env);
    if (rejection) return rejection;

    const beforeUpstream = Date.now();
    const upstream = await fetch(ANTHROPIC, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      // The status is forwarded; the body is not read, so an upstream error
      // message never passes through this Worker's memory as a string.
      return problem(upstream.status, "upstream_error");
    }

    /*
     * PASS-THROUGH STREAMING. `upstream.body` is handed to the Response
     * untouched, so tokens reach Otto as Anthropic emits them.
     *
     * Everything below is a way this has been got wrong and must not be:
     *   - `await upstream.text()` or `.json()`  — buffers the whole answer
     *   - awaiting a TransformStream to completion — same
     *   - `tee()`ing to count output tokens     — serialises the stream, which
     *     is exactly why this Worker counts REQUESTS and never reads responses
     *   - setting Content-Length                — forces buffering
     *
     * Otto's latency story depends on this line. A 2s time-to-first-token
     * becomes a 5s wait if the answer is assembled here first, and speech
     * cannot start early.
     */
    /*
     * `await fetch` resolves when Anthropic's response HEADERS arrive, so this
     * measures Anthropic's time to first byte and nothing of the relay. The
     * difference between it and `total` is what the relay itself costs — the
     * number that decides whether the relay is worth attacking.
     *
     * Timing only. No request or response content is measured, counted, or
     * described, and this adds no read of either body.
     */
    const upstreamMs = Date.now() - beforeUpstream;
    const total = Date.now() - t0;

    /*
     * `otto-usage` is a HEADER, and that is the whole design.
     *
     * The alternative was a GET /v1/usage endpoint Otto would call when the
     * user opened the menu bar panel. That would make network activity no
     * longer 1:1 with a question the user asked — a new category of request,
     * triggered by a UI gesture, needing its own line in the privacy page.
     * Here there is no new request, no new endpoint and no new state: every
     * number was already read by checkLimits before the upstream call.
     *
     * It rides on the response head, which Workers emit as soon as the
     * upstream headers arrive, so Otto has the numbers at time-to-first-token
     * rather than at the end of the answer. And it touches nothing of the
     * body, so it is not in the family of changes that breaks pass-through
     * streaming — asserted by the streaming test rather than argued here.
     */
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...gate.usage,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        "connection": "keep-alive",
        "server-timing": [
          `cold;dur=${cold ? 1 : 0}`,
          `auth;dur=${afterKV - t0}`,
          `kvtoken;dur=${timing.tokenRead}`,
          `kvread;dur=${timing.counterRead}`,
          `kvwrite;dur=${timing.counterWrite}`,
          `upstream;dur=${upstreamMs}`,
          `relay;dur=${total - upstreamMs}`,
        ].join(", "),
      },
    });
  },
};

// ------------------------------------------------------------ registration

/**
 * Mints a trial device token. Called once, on a Mac's first launch.
 *
 * THE WORKER GENERATES THE TOKEN, NOT THE APP, and this is a security property
 * rather than a preference. The token is a KV key. If the app chose it, anyone
 * could POST a token of their choosing — including one already belonging to a
 * paying account — and either collide with it or squat it before it is issued.
 * A client never names a key in someone else's namespace.
 *
 * NO AUTHENTICATION, because there is nothing yet to authenticate with: this is
 * the endpoint that hands out the first credential. That makes it mintable in a
 * loop by anyone who finds it, which is the same exposure as the Keychain-
 * deletion gap recorded in SPEC.md — bounded by the trial cap, ten questions and
 * roughly seven cents each time. Cloudflare rate limiting is the lever if it is
 * ever actually exploited; fingerprinting is not, and the SPEC amendment says so
 * to stop a later reader "fixing" it that way.
 *
 * D1 IS WRITTEN HERE AND NEVER ON THE QUESTION PATH. This route exists so that
 * /v1/ask can read one KV record and nothing else.
 */
async function registerDevice(request, env) {
  const plan = await loadPlan(env, "trial");
  if (!plan) return problem(503, "not_provisioned");

  const token = mintToken();

  // The KV record carries the caps THEMSELVES, not the plan's name, because the
  // question path must not look a plan up. That denormalisation is deliberate
  // and it has a cost: changing a cap in D1 does not reach records already
  // written. `npm run plans:apply` rewrites them and Bench/check-plan-sync.sh
  // fails if the two ever disagree — see the README.
  const record = {
    v: 2,
    subject: token,            // no account yet: the token is its own subject
    kind: "trial",
    plan: "trial",
    active: true,
    dailyCap: plan.daily_cap,
    hourlyCap: plan.hourly_cap,
    trialCap: plan.trial_cap,
  };

  await env.OTTO.put(`token:${token}`, JSON.stringify(record));

  // KV FIRST, D1 SECOND. If D1 fails the user still has a working trial and we
  // have lost a row we can reconstruct; the other order hands out a token that
  // does not work. Neither is free, and this is the failure that is invisible
  // to the person holding the Mac.
  try {
    await env.DB.prepare(
      `INSERT INTO devices (token, account_id, label, state, created_at)
       VALUES (?, NULL, ?, 'trial', ?)`
    ).bind(token, labelFrom(request), Date.now()).run();
  } catch (error) {
    // Deliberately not surfaced: the trial works. Logged as the operational
    // problem it is, with no token in the message.
    console.error("device row not written:", String(error && error.message));
  }

  /*
   * THE INITIAL STATE RIDES ON THE REGISTRATION REPLY, in the same header the
   * answer carries, so Otto has one parser and the panel has something to show
   * before the first question is spent. The counts are zero by construction —
   * a token minted a millisecond ago has a fresh subject and no counters — so
   * nothing is read for this; it is the record just written, said back.
   *
   * No new request exists: registration was already one. A26's claim that a
   * question is one request and nothing else is untouched.
   */
  const now = new Date();
  return new Response(JSON.stringify({ token, trialCap: plan.trial_cap }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...usageHeader(record, { day: 0, hour: 0, total: 0 }, now, false),
    },
  });
}

/** 32 bytes of CSPRNG, base64url. Not a UUID: this is a credential. */
function mintToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A human label for the device list, and nothing more.
 *
 * The app sends its machine name. It is never used for identity, never used to
 * decide entitlement, and is not a fingerprint — a user renaming their Mac
 * changes only what a row says.
 */
function labelFrom(request) {
  const label = request.headers.get("otto-device-label") || "";
  return label.slice(0, 64) || null;
}

/** Plans live in D1 so a cap is a row update rather than a deploy. */
async function loadPlan(env, name) {
  try {
    return await env.DB.prepare(
      `SELECT name, daily_cap, hourly_cap, trial_cap FROM plans WHERE name = ?`
    ).bind(name).first();
  } catch (error) {
    console.error("plan lookup failed:", String(error && error.message));
    return null;
  }
}

// ---------------------------------------------------------------- accounts

/**
 * A token record. VERSIONED from the first day, because retrofitting a schema
 * version onto records already in production means guessing at record shape.
 * That foresight is now being spent:
 *
 *   v1  { v: 1, name, active, dailyCap, hourlyCap }
 *   v2  { v: 2, subject, kind, plan, active, dailyCap, hourlyCap, trialCap }
 *
 * `subject` IS THE FIELD THAT MATTERS, and it is why v2 exists.
 *
 * Caps are per ACCOUNT, not per device: someone with a Mac and a MacBook has
 * one quota. The counters below therefore key on the subject rather than on the
 * token — and the subject has to be readable WITHOUT a database lookup, or the
 * question path acquires a second store and the whole design falls over. So it
 * is denormalised into the KV record, which is the one thing the hot path
 * already reads.
 *
 * For a trial there is no account, so the subject is the token itself. That
 * means trial and account share one code path with no branch in it.
 *
 * v1 RECORDS STILL WORK. Beta testers carry baked tokens minted before any of
 * this existed; refusing them would switch off every existing user to ship a
 * schema change. They are upgraded in memory, never rewritten, so the migration
 * is a read-time concern and there is no batch job that can half-finish.
 */
async function loadAccount(env, token) {
  const raw = await env.OTTO.get(`token:${token}`);
  if (!raw) return null;
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }

  if (record.v === 1) {
    return {
      subject: token,          // a v1 token was its own quota, and stays so
      kind: "legacy",
      plan: "legacy",
      active: record.active === true,
      dailyCap: Number(record.dailyCap) || 0,
      hourlyCap: Number(record.hourlyCap) || 0,
      trialCap: 0,
    };
  }

  if (record.v !== 2) return null;
  return {
    subject: String(record.subject || token),
    kind: String(record.kind || "device"),
    plan: String(record.plan || "free"),
    active: record.active === true,
    dailyCap: Number(record.dailyCap) || 0,
    hourlyCap: Number(record.hourlyCap) || 0,
    trialCap: Number(record.trialCap) || 0,
  };
}

// ------------------------------------------------------------------ limits

/**
 * Requests, not tokens.
 *
 * Counting output tokens would mean reading the response body, which is the
 * single most likely way to reintroduce buffering. Counting requests means this
 * Worker never touches a response at all, so pass-through streaming is
 * guaranteed by construction rather than by care.
 *
 * The tradeoff, stated plainly: this bounds the NUMBER of requests, not the
 * cost of each. A request carries roughly a 1,450-token screenshot plus prompt,
 * which at Opus rates is about $0.007 of input whether the answer is one line
 * or ten. `MAX_OUTPUT_TOKENS` caps the other side. Set caps knowing that.
 *
 * KV is eventually consistent, so a user may occasionally get one or two over
 * their cap. That is a cent, and it is the right trade for not needing a
 * strongly consistent store on the hot path.
 */
/**
 * Reads the counters and decides. Returns either a refusal or a `commit` that
 * performs the increment — separated so the caller can schedule the write
 * instead of awaiting it.
 */
async function checkLimits(env, account, timing = {}) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);          // YYYY-MM-DD
  const hour = now.toISOString().slice(0, 13);         // YYYY-MM-DDTHH

  // KEYED ON THE SUBJECT, NOT THE TOKEN. Two devices on one account share one
  // quota, which is what a subscription means to the person paying for it.
  const dayKey = `u:${account.subject}:d:${day}`;
  const hourKey = `u:${account.subject}:h:${hour}`;

  // The trial is a LIFETIME count, so it gets its own key with NO expiry. The
  // day and hour keys carry TTLs because a window that has rolled over is
  // meaningless; a trial that expired after 48 hours would simply hand out a
  // fresh ten, which is the opposite of a cap.
  const totalKey = `u:${account.subject}:total`;
  const onTrial = account.kind === "trial" && account.trialCap > 0;

  const tRead = Date.now();
  const [dayRaw, hourRaw, totalRaw] = await Promise.all([
    env.OTTO.get(dayKey),
    env.OTTO.get(hourKey),
    onTrial ? env.OTTO.get(totalKey) : Promise.resolve(null),
  ]);
  timing.counterRead = Date.now() - tRead;
  const dayCount = Number(dayRaw) || 0;
  const hourCount = Number(hourRaw) || 0;
  const totalCount = Number(totalRaw) || 0;

  // The hourly limit is the real protection against a runaway bill: a daily cap
  // can still be burned through in a minute by a loop.
  /*
   * What Otto shows the user about their own usage.
   *
   * COUNTED INCLUSIVE OF THIS REQUEST. `dayCount` is read before the increment
   * and the increment is scheduled unconditionally below, so reporting the raw
   * read would leave the display permanently one question behind and looking
   * broken after the very first question. On a refusal the counts are already
   * at the cap and are reported as they are.
   *
   * The reset seconds are here because the counters roll over at UTC midnight
   * and UTC hour. A display saying "today" would be wrong for a third of the
   * day for anyone west of Greenwich; "resets in 6h" is true everywhere and
   * needs no timezone to exist anywhere in the system.
   */
  const usage = (inclusive) =>
    usageHeader(account, { day: dayCount, hour: hourCount, total: totalCount }, now, inclusive);

  // The refusal carries the counts too. It is the moment a user most wants to
  // see the bar full, and it means Otto has one place that parses this.
  // FIRST, because it is the most specific and the only one a user can act on
  // by doing something other than waiting. "Try again in about 40 minutes" is
  // the wrong sentence for someone whose trial is over — the hourly cap would
  // otherwise answer first and send them away to wait for nothing.
  //
  // No retryAfter: there is no time at which this resolves itself.
  if (onTrial && totalCount >= account.trialCap) {
    return { refused: problem(403, "trial_exhausted", {}, usage(false)) };
  }

  if (account.hourlyCap > 0 && hourCount >= account.hourlyCap) {
    return {
      refused: problem(429, "hourly_limit",
                       { retryAfter: secondsToNextHour(now) }, usage(false)),
    };
  }
  if (account.dailyCap > 0 && dayCount >= account.dailyCap) {
    return {
      refused: problem(429, "daily_limit",
                       { retryAfter: secondsToNextDay(now) }, usage(false)),
    };
  }

  timing.counterWrite = 0;   // no longer on the critical path
  return {
    refused: null,
    usage: usage(true),
    commit: () =>
      Promise.all([
        env.OTTO.put(dayKey, String(dayCount + 1), { expirationTtl: 60 * 60 * 48 }),
        env.OTTO.put(hourKey, String(hourCount + 1), { expirationTtl: 60 * 60 * 2 }),
        // No expirationTtl, deliberately. See the key's comment above.
        ...(onTrial ? [env.OTTO.put(totalKey, String(totalCount + 1))] : []),
      ]),
  };
}

/**
 * The `otto-usage` header, from counts already in hand.
 *
 * ONE FUNCTION FOR BOTH PLACES IT IS SENT: on every answer and refusal, and on
 * the registration reply. Two compositions of the same header would drift the
 * moment one gained a field, and Otto has exactly one parser for it.
 *
 * `inclusive` adds the request being answered, because checkLimits reads the
 * counters before the increment is scheduled and reporting the raw read would
 * leave the display one question behind forever. Registration passes false:
 * nothing is being spent.
 *
 * The trial fields appear only while a trial is running. Otto shows "7 of 10
 * free questions left" from them and shows nothing about a trial once there is
 * an account behind the token — the ABSENCE of the fields is the signal.
 */
function usageHeader(account, counts, now, inclusive) {
  const onTrial = account.kind === "trial" && Number(account.trialCap) > 0;
  const plus = inclusive ? 1 : 0;
  return {
    "otto-usage": [
      `day=${counts.day + plus}`,
      `day-cap=${account.dailyCap}`,
      `hour=${counts.hour + plus}`,
      `hour-cap=${account.hourlyCap}`,
      `day-resets=${secondsToNextDay(now)}`,
      `hour-resets=${secondsToNextHour(now)}`,
      ...(onTrial ? [`trial=${counts.total + plus}`, `trial-cap=${account.trialCap}`] : []),
    ].join(";"),
  };
}

const secondsToNextHour = (now) => 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds());
const secondsToNextDay = (now) =>
  86400 - (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds());

// -------------------------------------------------------------- validation

/**
 * Bounds what a leaked token can ask for, so it is not a general-purpose
 * Anthropic proxy.
 *
 * Deliberately does NOT own the system prompt. Injecting it here would bound
 * abuse a little further and couple every prompt change to a Worker deploy,
 * which is the wrong trade while the prompt is still being tuned.
 */
function validate(body, env) {
  if (typeof body !== "object" || body === null) return problem(400, "bad_request");
  if (!ALLOWED_MODELS.has(body.model)) return problem(400, "model_not_allowed");
  if (body.stream !== true) return problem(400, "stream_required");

  const maxOutput = Number(env.MAX_OUTPUT_TOKENS) || 4096;
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > maxOutput) {
    return problem(400, "max_tokens_out_of_range");
  }

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) return problem(400, "messages_required");

  let images = 0;
  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) if (block && block.type === "image") images += 1;
  }
  if (images > (Number(env.MAX_IMAGES) || 2)) return problem(400, "too_many_images");

  return null;
}

// ------------------------------------------------------------------ errors

/**
 * Errors carry a code and nothing else. No echo of the request, so a
 * screenshot cannot end up in an error body any more than it can in a log.
 */
function problem(status, code, extra = {}, headers = {}) {
  return new Response(JSON.stringify({ error: code, ...extra }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

/**
 * Runs work after the response, and says so when it fails.
 *
 * Deferring the counter write makes it less reliable on purpose, so the failure
 * must not be silent — a lost write is a free request, and at scale a pattern of
 * them is the difference between a cap that holds and one that does not. The
 * message carries no token and no request content: it says what failed, not for
 * whom. Visible with `wrangler tail`; observability stays off.
 */
function defer(ctx, work, what) {
  const reported = Promise.resolve(work).catch((error) => {
    console.error(`deferred ${what} failed: ${error && error.message ? error.message : error}`);
  });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(reported);
  return reported;
}

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}
