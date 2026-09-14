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

import {
  CLOUD_TOOLS, APPS, composioArguments, compact, integrationsHeader,
  looksLikeLostAuthorization, verifyWebhookSignature,
} from "./tools.js";

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const COMPOSIO = "https://backend.composio.dev/api/v3.1";
const COMPOSIO_TIMEOUT_MS = 20_000;

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

    const url = new URL(request.url);

    // THE ONE GET: the browser lands here after a connect. Everything else is
    // POST, and the 405 below still covers it.
    if (request.method === "GET" && url.pathname === "/v1/integrations/callback") {
      return integrationsCallback(request, env);
    }
    if (request.method !== "POST") return problem(405, "method_not_allowed");

    // Registration is a separate route on purpose, and it is the ONLY other one.
    // Everything the question path needs is below; nothing it calls reaches D1
    // or any identity provider. Bench/check-question-path.sh asserts that by
    // grep rather than by reading, in the style of the app's check-monitors.sh.
    if (url.pathname === "/v1/device") return registerDevice(request, env);
    // Sign-in is two more routes, two more requests, and — like registration —
    // NOT the question path. Supabase is reached from these and nowhere else.
    if (url.pathname === "/v1/signin") return signInStart(request, env);
    if (url.pathname === "/v1/signin/verify") return signInVerify(request, env);
    // Connected apps (A76): a tool call, the page's status, connect, disconnect,
    // and Composio's webhook. D1 and Composio are reached from these and never
    // from the question path — Bench/check-tool-path.sh.
    if (url.pathname === "/v1/tool") return runTool(request, env);
    if (url.pathname === "/v1/integrations") return integrationsStatus(request, env);
    if (url.pathname === "/v1/integrations/link") return integrationsLink(request, env);
    if (url.pathname === "/v1/integrations/unlink") return integrationsUnlink(request, env);
    if (url.pathname === "/v1/integrations/webhook") return integrationsWebhook(request, env);

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

    /*
     * BOUNDED BEFORE IT IS PARSED. `MAX_BODY_BYTES` was declared in
     * wrangler.toml from the first deploy and enforced nowhere — a declared cap
     * that nothing reads is a comment. A question is a ~200KB body (one 1200px
     * JPEG as base64 plus a few KB of text and, since Otto's A72, up to five
     * remembered exchanges of plain text); the cap is thirty times that, so it
     * bounds abuse rather than use. Checked on the declared length first, then
     * on the bytes actually received, because Content-Length is a claim. The
     * body is read as bytes and decoded once, so this adds no copy that
     * `request.json()` was not already making. 413, and a code Otto's
     * RelayError maps to "a bug in Otto" — the user cannot act on it.
     */
    const maxBody = Number(env.MAX_BODY_BYTES) || 6_000_000;
    const declared = Number(request.headers.get("content-length"));
    if (declared > maxBody) return problem(413, "body_too_large");

    let body;
    try {
      const raw = await request.arrayBuffer();
      if (raw.byteLength > maxBody) return problem(413, "body_too_large");
      body = JSON.parse(new TextDecoder().decode(raw));
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
  // KEYED ON THE SUBJECT, NOT THE TOKEN. Two devices on one account share one
  // quota, which is what a subscription means to the person paying for it.
  const { dayKey, hourKey, totalKey } = counterKeys(account.subject, now);
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

/**
 * The counter keys for a subject at a moment. Pure, so the question path and
 * sign-in's usage reply agree on the key format by construction rather than by
 * two copies of a template string.
 *
 * The trial is a LIFETIME count, so it gets its own key with NO expiry. The day
 * and hour keys carry TTLs (set where they are written) because a window that
 * has rolled over is meaningless; a trial that expired after 48 hours would
 * simply hand out a fresh ten, which is the opposite of a cap.
 */
function counterKeys(subject, now) {
  const day = now.toISOString().slice(0, 10);          // YYYY-MM-DD
  const hour = now.toISOString().slice(0, 13);         // YYYY-MM-DDTHH
  return {
    dayKey: `u:${subject}:d:${day}`,
    hourKey: `u:${subject}:h:${hour}`,
    totalKey: `u:${subject}:total`,
  };
}

const secondsToNextHour = (now) => 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds());
const secondsToNextDay = (now) =>
  86400 - (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds());

// ----------------------------------------------------------------- sign-in

/**
 * Sign-in: a six-digit code sent to an email address, checked by Supabase, and
 * a device token bound to an account issued in exchange. Two routes, two
 * requests, and — like registration — NOT the question path. SPEC.md A70.
 *
 * SUPABASE IS REACHED FROM HERE AND NOWHERE ELSE. Otto never holds a Supabase
 * credential of any kind; the key lives in this Worker, is read in exactly one
 * function (`supabase`), and is sent as the `apikey` header — it is a
 * per-service secret key (sb_secret_…), not a JWT, so it is never a bearer.
 * Bench/check-question-path.sh asserts the single reader and that neither
 * route is reachable from /v1/ask.
 *
 * WHAT IS NEVER LOGGED: the address, the code, either token, the key, and the
 * Supabase session. Error lines say which step failed, not for whom.
 *
 * BOTH ROUTES REQUIRE A DEVICE TOKEN (D3). A registered device — trial, legacy
 * or account — may ask for a code; nothing else may. That makes the mailer cost
 * a registration per attempt rather than being an open sender through
 * sayotto.app's new and fragile reputation.
 */

/** The bearer, validated the way /v1/ask validates it. */
async function authenticate(request, env) {
  const token = bearer(request);
  if (!token) return { refused: problem(401, "missing_token") };
  const account = await loadAccount(env, token);
  if (!account) return { refused: problem(401, "unknown_token") };
  if (!account.active) return { refused: problem(403, "revoked") };
  return { token, account };
}

/**
 * Trim, lowercase, and require exactly one `@` with something either side.
 * Nothing more: Supabase and the mail provider are the authorities on what is
 * deliverable, and a stricter regex here would refuse real addresses.
 */
function normaliseEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@") || at === email.length - 1) return null;
  return email;
}

/**
 * One call to Supabase Auth. THE ONLY READER OF THE KEY.
 *
 * Returns `{ unavailable: true }` for anything that is our problem rather than
 * the user's — no configuration, no network, a 5xx — so callers map it to one
 * sentence ("could not reach its sign-in service") and never leak which.
 */
async function supabase(env, path, body) {
  const key = env.SUPABASE_SECRET_KEY;   // read once; the only read in this file
  if (!env.SUPABASE_URL || !key) {
    console.error("sign-in is not provisioned: SUPABASE_URL or the secret key is missing");
    return { unavailable: true };
  }
  let response;
  try {
    response = await fetch(`${env.SUPABASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: key },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // THE ERROR'S MESSAGE IS NOT LOGGED. A transport error can carry the
    // request into its string form, and the request carries the address.
    // The name of the error class says what happened; nothing else is needed.
    console.error(`identity provider unreachable at ${path} (${error && error.name ? error.name : "error"})`);
    return { unavailable: true };
  }
  if (response.status >= 500) {
    console.error(`identity provider failed at ${path}: HTTP ${response.status}`);
    return { unavailable: true };
  }
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json, retryAfter: Number(response.headers.get("retry-after")) || 0 };
}

function json200(object, headers = {}) {
  return new Response(JSON.stringify(object), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/**
 * POST /v1/signin  { email }  →  200 {}
 *
 * Asks Supabase to email a code. WRITES NOTHING — no row, no key, no log line
 * with the address in it; the address exists in this isolate for the length of
 * one fetch. The reply is the same for a new address and a returning one, so a
 * caller cannot learn whether an address is known.
 */
async function signInStart(request, env) {
  const auth = await authenticate(request, env);
  if (auth.refused) return auth.refused;

  let body;
  try { body = await request.json(); } catch { return problem(400, "malformed_json"); }
  const email = normaliseEmail(body && body.email);
  if (!email) return problem(400, "bad_email");

  // create_user: a first sign-in IS the sign-up. Supabase picks the template.
  const reply = await supabase(env, "/auth/v1/otp", { email, create_user: true });
  if (reply.unavailable) return problem(503, "identity_unavailable");
  if (reply.status === 429) return problem(429, "rate_limited", { retryAfter: reply.retryAfter || 60 });
  if (reply.status === 400 || reply.status === 422) return problem(400, "bad_email");
  if (reply.status !== 200) {
    // A 401/403 here is OUR key or configuration, never the user's address.
    console.error(`code not sent: identity provider answered HTTP ${reply.status}`);
    return problem(503, "identity_unavailable");
  }
  return json200({});
}

/**
 * POST /v1/signin/verify  { email, code }  →  200 { token, email } + otto-usage
 *
 * Checks the code with Supabase, then REPLACES the bearer's token with one bound
 * to the account (A62: replace, do not adopt). In order:
 *
 *   1. Supabase verifies. Only `user.id` and `user.email` are read from the
 *      session; the access and refresh tokens are DISCARDED here and never
 *      stored, forwarded or logged. Otto never holds a Supabase credential.
 *   2. The account is found by Supabase user id, relinked by email if the
 *      identity was recreated upstream, or created on the plan D2 chose: `beta`
 *      for a legacy (baked v1) bearer, `free` for everything else.
 *   3. A new token is minted and its KV record written with subject = the
 *      ACCOUNT id, so two Macs on one account share one quota.
 *   4. D1 rows: the new device inserted, the old one revoked. KV FIRST, D1
 *      SECOND, as registration does: a failure here leaves a working token and
 *      a reconstructible row, and is logged without token or address.
 *   5. The bearer's own KV record is retired (active: false) — unless it is a
 *      v1 record, which are set by hand and never rewritten (A62). The ten
 *      trial questions are forgiven, not carried: the account's counters are
 *      the account's, and the trial's are simply never read again.
 *   6. The reply carries the account's current counters in the usage header —
 *      a second Mac signing in sees what the first has spent. This read is
 *      off the question path, so it is allowed.
 */
async function signInVerify(request, env) {
  const auth = await authenticate(request, env);
  if (auth.refused) return auth.refused;

  let body;
  try { body = await request.json(); } catch { return problem(400, "malformed_json"); }
  const email = normaliseEmail(body && body.email);
  if (!email) return problem(400, "bad_email");
  const code = String((body && body.code) || "").trim();
  // Malformed and wrong get one sentence: Supabase does not reliably separate
  // an expired code from a wrong one either, so neither do we.
  if (!/^\d{6}$/.test(code)) return problem(403, "code_invalid");

  const reply = await supabase(env, "/auth/v1/verify", { type: "email", email, token: code });
  if (reply.unavailable) return problem(503, "identity_unavailable");
  if (reply.status === 429) return problem(429, "rate_limited", { retryAfter: reply.retryAfter || 60 });
  const supabaseUser = reply.status === 200 && reply.json && reply.json.user;
  if (!supabaseUser || !supabaseUser.id) return problem(403, "code_invalid");
  // THE SESSION ENDS HERE. Two fields survive; nothing else from the reply is
  // referenced again, so nothing else can be written anywhere.
  const user = { id: String(supabaseUser.id), email: normaliseEmail(supabaseUser.email) || email };

  const planForNewAccount = auth.account.kind === "legacy" ? "beta" : "free";
  let account;
  try {
    account = await findOrCreateAccount(env, user, planForNewAccount);
  } catch (error) {
    console.error("account lookup failed:", String(error && error.message));
    return problem(503, "identity_unavailable");
  }

  const caps = await loadPlan(env, account.plan);
  if (!caps) return problem(503, "not_provisioned");

  const token = mintToken();
  const record = {
    v: 2,
    subject: account.id,        // the ACCOUNT: two devices, one quota
    kind: "device",
    plan: account.plan,
    active: true,
    dailyCap: caps.daily_cap,
    hourlyCap: caps.hourly_cap,
    trialCap: caps.trial_cap,
  };
  await env.OTTO.put(`token:${token}`, JSON.stringify(record));

  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO devices (token, account_id, label, state, created_at)
       VALUES (?, ?, ?, 'active', ?)`
    ).bind(token, account.id, labelFrom(request), now).run();
    await env.DB.prepare(
      `UPDATE devices SET state = 'revoked', revoked_at = ? WHERE token = ? AND state != 'revoked'`
    ).bind(now, auth.token).run();
  } catch (error) {
    console.error("device rows not written:", String(error && error.message));
  }

  if (auth.account.kind !== "legacy") {
    try {
      const raw = await env.OTTO.get(`token:${auth.token}`);
      const old = raw ? JSON.parse(raw) : null;
      if (old) await env.OTTO.put(`token:${auth.token}`, JSON.stringify({ ...old, active: false }));
    } catch (error) {
      console.error("previous token not retired:", String(error && error.message));
    }
  }

  const at = new Date();
  const keys = counterKeys(account.id, at);
  const [dayRaw, hourRaw] = await Promise.all([env.OTTO.get(keys.dayKey), env.OTTO.get(keys.hourKey)]);
  const header = usageHeader(record, { day: Number(dayRaw) || 0, hour: Number(hourRaw) || 0, total: 0 }, at, false);
  return json200({ token, email: user.email }, header);
}

/**
 * The account behind a Supabase user, created if this is its first sign-in.
 *
 * Matched by Supabase user id first, so an address change upstream does not
 * fork an account. An address that exists WITHOUT this id means the identity
 * was recreated on the Supabase side; it is relinked rather than duplicated,
 * which the UNIQUE constraint on email would refuse anyway.
 */
async function findOrCreateAccount(env, user, plan) {
  const byUser = await env.DB.prepare(
    `SELECT id, plan FROM accounts WHERE supabase_user_id = ? AND deleted_at IS NULL`
  ).bind(user.id).first();
  if (byUser) return byUser;

  const byEmail = await env.DB.prepare(
    `SELECT id, plan FROM accounts WHERE email = ? AND deleted_at IS NULL`
  ).bind(user.email).first();
  if (byEmail) {
    await env.DB.prepare(`UPDATE accounts SET supabase_user_id = ? WHERE id = ?`)
      .bind(user.id, byEmail.id).run();
    return byEmail;
  }

  // An id, not a credential: it names a quota, it never authenticates one.
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO accounts (id, email, supabase_user_id, plan, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(id, user.email, user.id, plan, Date.now()).run();
  return { id, plan };
}

// ---------------------------------------------------------- connected apps

/**
 * Connected apps: Gmail, Google Calendar and Slack through Composio (SPEC.md
 * A76). Five routes plus the browser callback, and NONE OF THEM IS THE
 * QUESTION PATH — a question still touches KV and Anthropic and nothing else.
 *
 * WHAT THE WORKER HOLDS: `COMPOSIO_API_KEY`, read in exactly one function
 * (`composio`); `COMPOSIO_WEBHOOK_SECRET`, read in one; and, in D1, which apps
 * an account connected and Composio's id for each authorization. The
 * authorization itself lives at Composio. Tool arguments and results pass
 * through this isolate for the length of one request and are not logged,
 * counted or stored; the log names the tool and the outcome and never the
 * words.
 *
 * WHO A CLOUD TOOL BELONGS TO: the account subject — the same id the quota is
 * keyed on — never the email. A trial device has no account and is refused
 * with `needs_account` before anything is looked up.
 */

/** One call to Composio. THE ONLY READER OF THE KEY. */
async function composio(env, method, path, body) {
  const key = env.COMPOSIO_API_KEY;   // read once; the only read in this file
  if (!key) {
    console.error("connected apps are not provisioned: COMPOSIO_API_KEY is missing");
    return { unavailable: true };
  }
  let response;
  try {
    // BOUNDED. A connector call that never returns would hold Otto's tool
    // request open past the app's own deadline; twenty seconds is above any
    // measured execute (about 1.1 to 1.4s) and below what a user waits.
    response = await fetch(`${COMPOSIO}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-api-key": key },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(COMPOSIO_TIMEOUT_MS),
    });
  } catch (error) {
    // The class of the error, never its message: a transport error's string
    // form can carry the request, and the request carries the arguments.
    console.error(`connector unreachable at ${method} ${path.split("?")[0]} (${error && error.name ? error.name : "error"})`);
    return { unavailable: true };
  }
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json };
}

/**
 * The account's rows, for the header and the page.
 *
 * A PENDING ROW OLDER THAN THE LINK IS REPORTED AS NONE. Composio's hosted
 * link lives ten minutes; a connect the browser never finished would
 * otherwise read "connecting" on every open with no exit. The row itself is
 * kept — a late callback can still make it active — but what Otto is told is
 * that there is nothing to wait for. A comparison at read time, no timer.
 */
const PENDING_LIFETIME_MS = 10 * 60 * 1000;

async function integrationRows(env, accountId, now = Date.now()) {
  const result = await env.DB.prepare(
    `SELECT app, connected_account_id, state, updated_at FROM integrations WHERE account_id = ?`
  ).bind(accountId).all();
  const rows = (result && result.results) || [];
  return rows.map((row) =>
    row.state === "pending" && now - Number(row.updated_at || 0) > PENDING_LIFETIME_MS
      ? { ...row, state: "none" }
      : row);
}

/** A bearer with an account behind it, or the refusal that says why not. */
async function authenticateAccount(request, env) {
  const auth = await authenticate(request, env);
  if (auth.refused) return auth;
  if (auth.account.kind !== "device") return { refused: problem(403, "needs_account") };
  return auth;
}

/**
 * POST /v1/tool  { tool, input, now, tz }  →  200 { ok: true, result, id } + otto-integrations
 *
 * One tool, one Composio call. In order: the bearer must have an account; the
 * tool must be one of Otto's cloud tools; the tool counter must be under the
 * plan's cap; the app must be connected; then Composio runs the action and
 * the reply is compacted. A refused execute that looks like a lost
 * authorization marks the row expired and answers `needs_signin`, which Otto
 * speaks as "Gmail needs you to sign in again".
 */
async function runTool(request, env) {
  const auth = await authenticateAccount(request, env);
  if (auth.refused) return auth.refused;
  const accountId = auth.account.subject;

  let body;
  try { body = await request.json(); } catch { return problem(400, "malformed_json"); }
  const tool = body && typeof body.tool === "string" ? body.tool : "";
  const spec = CLOUD_TOOLS[tool];
  if (!spec) return problem(400, "unknown_tool");
  const now = body && typeof body.now === "string" ? body.now : new Date().toISOString();
  const tz = body && typeof body.tz === "string" && body.tz ? body.tz : "UTC";
  const args = composioArguments(tool, body.input, now, tz);
  if (!args) return problem(400, "unknown_tool");

  // The tool cap, from the plan row. Off the question path, so D1 is allowed
  // here; zero means no gate, as for every other cap.
  const plan = await loadPlanCaps(env, auth.account.plan);
  const toolCap = plan ? Number(plan.tool_cap) || 0 : 0;
  const toolKey = `u:${accountId}:t:${new Date().toISOString().slice(0, 10)}`;
  const used = Number(await env.OTTO.get(toolKey)) || 0;
  if (toolCap > 0 && used >= toolCap) return problem(429, "tool_limit");

  let rows;
  try { rows = await integrationRows(env, accountId); } catch (error) {
    console.error("integration rows unreadable:", String(error && error.message));
    return problem(503, "not_provisioned");
  }
  const headers = integrationsHeader(rows);
  const row = rows.find((r) => r.app === spec.app);
  if (!row || row.state !== "active") {
    return problem(403, "needs_signin", { app: spec.app }, headers);
  }

  // Counted before the call, like questions: a failed call still counts.
  await env.OTTO.put(toolKey, String(used + 1), { expirationTtl: 60 * 60 * 48 });

  const reply = await composio(env, "POST", `/tools/execute/${spec.slug}`, {
    user_id: accountId,
    connected_account_id: row.connected_account_id,
    arguments: args,
  });
  if (reply.unavailable) return problem(503, "tool_failed", { reason: "unreachable" }, headers);
  const ok = reply.status === 200 && reply.json && reply.json.successful === true;
  if (!ok) {
    const error = reply.json && (reply.json.error || (reply.json.data && reply.json.data.error));
    if (reply.status === 401 || reply.status === 403 || looksLikeLostAuthorization(error)) {
      await markIntegration(env, accountId, spec.app, "expired");
      console.error(`tool ${tool}: the ${spec.app} authorization has lapsed`);
      return problem(403, "needs_signin", { app: spec.app },
                     integrationsHeader(rows.map((r) => (r.app === spec.app ? { ...r, state: "expired" } : r))));
    }
    // The status, never the message: the message can quote the arguments.
    console.error(`tool ${tool}: connector answered HTTP ${reply.status}, successful=${ok}`);
    return problem(502, "tool_failed", { reason: "connector" }, headers);
  }

  const { result, id } = compact(tool, reply.json.data);
  console.log(`tool ${tool} ran for ${spec.app}`);
  return json200({ ok: true, result, id }, headers);
}

/** The plan row with its tool cap. Never called from the question path. */
async function loadPlanCaps(env, name) {
  try {
    return await env.DB.prepare(
      `SELECT name, daily_cap, hourly_cap, trial_cap, tool_cap FROM plans WHERE name = ?`
    ).bind(name).first();
  } catch (error) {
    console.error("plan lookup failed:", String(error && error.message));
    return null;
  }
}

async function markIntegration(env, accountId, app, state, connectedAccountId) {
  try {
    if (connectedAccountId) {
      await env.DB.prepare(
        `INSERT INTO integrations (account_id, app, connected_account_id, state, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, app) DO UPDATE SET
           connected_account_id = excluded.connected_account_id,
           state = excluded.state, updated_at = excluded.updated_at`
      ).bind(accountId, app, connectedAccountId, state, Date.now()).run();
    } else {
      await env.DB.prepare(
        `UPDATE integrations SET state = ?, updated_at = ? WHERE account_id = ? AND app = ?`
      ).bind(state, Date.now(), accountId, app).run();
    }
  } catch (error) {
    console.error("integration row not written:", String(error && error.message));
  }
}

/**
 * POST /v1/integrations  →  200 { apps: { gmail, gcal, slack } } + otto-integrations
 *
 * Read when the Integrations page opens, and at no other time (decision 7).
 */
async function integrationsStatus(request, env) {
  const auth = await authenticate(request, env);
  if (auth.refused) return auth.refused;
  if (auth.account.kind !== "device") {
    return json200({ apps: Object.fromEntries(APPS.map((a) => [a, "none"])), account: false },
                   integrationsHeader([]));
  }
  let rows;
  try { rows = await integrationRows(env, auth.account.subject); } catch (error) {
    console.error("integration rows unreadable:", String(error && error.message));
    return problem(503, "not_provisioned");
  }
  const apps = Object.fromEntries(APPS.map((a) => [a, "none"]));
  for (const row of rows) apps[row.app] = row.state;
  return json200({ apps, account: true }, integrationsHeader(rows));
}

/**
 * POST /v1/integrations/link  { app }  →  200 { url }
 *
 * Asks Composio for a hosted sign-in link for this account and app, under the
 * managed auth config named in [vars], and records the pending row so the
 * callback can recognise the authorization when the browser comes back. The
 * link expires at Composio's ten minutes; Otto opens it at once.
 */
async function integrationsLink(request, env) {
  const auth = await authenticateAccount(request, env);
  if (auth.refused) return auth.refused;
  let body;
  try { body = await request.json(); } catch { return problem(400, "malformed_json"); }
  const app = body && typeof body.app === "string" ? body.app : "";
  if (!APPS.includes(app)) return problem(400, "unknown_app");

  const authConfig = authConfigFor(env, app);
  if (!authConfig) return problem(503, "not_provisioned");

  const origin = new URL(request.url).origin;
  const reply = await composio(env, "POST", "/connected_accounts/link", {
    user_id: auth.account.subject,
    auth_config_id: authConfig,
    callback_url: `${origin}/v1/integrations/callback`,
  });
  if (reply.unavailable) return problem(503, "connector_unavailable");
  const url = reply.json && typeof reply.json.redirect_url === "string" ? reply.json.redirect_url : null;
  const connectedAccountId = reply.json && typeof reply.json.connected_account_id === "string"
    ? reply.json.connected_account_id : null;
  if (reply.status !== 201 && reply.status !== 200 || !url || !connectedAccountId) {
    console.error(`connect link for ${app} refused: HTTP ${reply.status}`);
    return problem(502, "connector_refused");
  }
  await markIntegration(env, auth.account.subject, app, "pending", connectedAccountId);
  console.log(`connect link issued for ${app}`);
  return json200({ url });
}

/** The managed auth config id for an app, from [vars]. Ids, not secrets. */
function authConfigFor(env, app) {
  switch (app) {
    case "gmail": return env.COMPOSIO_AUTH_CONFIG_GMAIL || null;
    case "gcal":  return env.COMPOSIO_AUTH_CONFIG_GCAL || null;
    case "slack": return env.COMPOSIO_AUTH_CONFIG_SLACK || null;
    default:      return null;
  }
}

/**
 * GET /v1/integrations/callback?status=…&connected_account_id=…
 *
 * The browser, after Composio's hosted sign-in. UNAUTHENTICATED, so nothing in
 * the query is trusted: the id must match a pending row this Worker wrote,
 * and Composio must report the account ACTIVE, before the row becomes active.
 * Then a page that says the one thing the user needs.
 */
async function integrationsCallback(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get("connected_account_id") || "";
  let outcome = "not_found";
  if (/^ca_[A-Za-z0-9_-]{4,}$/.test(id)) {
    let row = null;
    try {
      row = await env.DB.prepare(
        `SELECT account_id, app FROM integrations WHERE connected_account_id = ?`
      ).bind(id).first();
    } catch (error) {
      console.error("integration row unreadable at callback:", String(error && error.message));
    }
    if (row) {
      const reply = await composio(env, "GET", `/connected_accounts/${id}`);
      const status = reply.json && typeof reply.json.status === "string" ? reply.json.status : "";
      if (reply.status === 200 && status === "ACTIVE") {
        await markIntegration(env, row.account_id, row.app, "active");
        outcome = "connected";
      } else {
        outcome = status === "INITIATED" ? "pending" : "failed";
      }
      console.log(`connect callback for ${row.app}: ${outcome}`);
    }
  }
  const sentence = {
    connected: "Connected. You can return to Otto.",
    pending: "Not finished yet. Close this and try Connect again in Otto.",
    failed: "That didn't connect. Close this and try Connect again in Otto.",
    not_found: "This link isn't one Otto is waiting for.",
  }[outcome];
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Otto</title>
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;color:#222;background:#f6f6f6;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{padding:32px;text-align:center}</style>
<main><p>${sentence}</p></main>`;
  return new Response(html, {
    status: outcome === "connected" ? 200 : 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * POST /v1/integrations/unlink  { app }  →  200 {} + otto-integrations
 *
 * Deletes the authorization at Composio, then the row. Composio refusing does
 * not keep the row: a user who clicked Disconnect gets a disconnected app.
 */
async function integrationsUnlink(request, env) {
  const auth = await authenticateAccount(request, env);
  if (auth.refused) return auth.refused;
  let body;
  try { body = await request.json(); } catch { return problem(400, "malformed_json"); }
  const app = body && typeof body.app === "string" ? body.app : "";
  if (!APPS.includes(app)) return problem(400, "unknown_app");
  const accountId = auth.account.subject;

  let rows = [];
  try { rows = await integrationRows(env, accountId); } catch (error) {
    console.error("integration rows unreadable:", String(error && error.message));
  }
  const row = rows.find((r) => r.app === app);
  if (row) {
    const reply = await composio(env, "DELETE", `/connected_accounts/${row.connected_account_id}`);
    if (reply.unavailable || (reply.status !== 200 && reply.status !== 204 && reply.status !== 404)) {
      console.error(`disconnect for ${app}: connector answered HTTP ${reply.status || "none"}`);
    }
    try {
      await env.DB.prepare(`DELETE FROM integrations WHERE account_id = ? AND app = ?`)
        .bind(accountId, app).run();
    } catch (error) {
      console.error("integration row not deleted:", String(error && error.message));
    }
  }
  console.log(`disconnected ${app}`);
  return json200({}, integrationsHeader(rows.filter((r) => r.app !== app)));
}

/**
 * POST /v1/integrations/webhook  — Composio's events, signed.
 *
 * VERIFIED BEFORE IT IS PARSED: HMAC-SHA256 over id.timestamp.rawBody with the
 * webhook secret, and a timestamp within five minutes. Only one event is acted
 * on — a connected account expiring — and it sets one row's state. Everything
 * else is acknowledged and dropped. The secret has exactly one reader.
 */
async function integrationsWebhook(request, env) {
  const secret = env.COMPOSIO_WEBHOOK_SECRET;   // read once; the only read in this file
  if (!secret) {
    console.error("webhook is not provisioned: COMPOSIO_WEBHOOK_SECRET is missing");
    return problem(503, "not_provisioned");
  }
  const raw = await request.text();
  const verified = await verifyWebhookSignature({
    id: request.headers.get("webhook-id"),
    timestamp: request.headers.get("webhook-timestamp"),
    signature: request.headers.get("webhook-signature"),
    body: raw,
    secret,
  });
  if (!verified) return problem(401, "bad_signature");

  let event;
  try { event = JSON.parse(raw); } catch { return problem(400, "malformed_json"); }
  const type = event && typeof event.type === "string" ? event.type : "";
  if (type === "composio.connected_account.expired") {
    const id = event.data && typeof event.data.id === "string" ? event.data.id : "";
    if (id) {
      try {
        await env.DB.prepare(
          `UPDATE integrations SET state = 'expired', updated_at = ? WHERE connected_account_id = ?`
        ).bind(Date.now(), id).run();
      } catch (error) {
        console.error("integration row not marked expired:", String(error && error.message));
      }
      console.log("a connected account expired; its row is marked");
    }
  }
  return json200({});
}

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
