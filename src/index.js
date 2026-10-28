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
  NeedsDetail, DEFAULT_LOOKUPS, defaultsFromReplies,
} from "./tools.js";
// Long-running tasks (SPEC.md A82). The registry and the header composer are
// pure; run.js holds the D1 helpers the task routes share with the Workflow.
// None of this is on the question path except the one pure header composer,
// which checkLimits feeds from a KV key — Bench/check-task-path.sh.
import {
  TYPES, TASK_VERSION, CREATE_KEYS, REQUEST_MAX_CHARS, CONTEXT_MAX_CHARS, DOCUMENT_MAX_BYTES,
  BROWSER_MODES, URL_MAX_CHARS, BROWSER_MAX_STEPS, BROWSER_MAX_CALLS, SPOKEN_MAX_CHARS,
} from "./tasks/registry.js";
import {
  STEP_KEYS, STEP_KINDS, STEP_BODY_MAX_BYTES, STEP_LABEL_MAX, STEP_SENTENCE_MAX, ledgerText, stepsOf,
} from "./tasks/browser.js";
import { tasksHeader, TERMINAL, BROWSER_END_REASONS } from "./tasks/summary.js";
import {
  insertRow, readRow, deleteRow, markState, finishTask, taskRows, writeSummary,
  tasksHeaderFor, deleteInstance, terminateInstance, appendStep, countCall,
} from "./tasks/run.js";
// The feed (A84): the account's tasks as server-sent events, and the one
// projection the feed and the list share.
import { openFeed, projectRow } from "./tasks/feed.js";
import { cleanTitle, fallbackTitle } from "./tasks/title.js";

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

/**
 * Models a browser step may ask for (A89 §11): the question's three and the
 * 5.5 models, on /v1/tasks/ask ONLY. The question's set above is unchanged.
 */
const STEP_MODELS = new Set([
  ...ALLOWED_MODELS,
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
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
    // Tasks (A82): six routes, none of them the question path. D1 and the
    // Workflow binding are reached from these and from the Workflow itself;
    // a question reads one KV key and nothing else — Bench/check-task-path.sh.
    if (url.pathname === "/v1/tasks/create") return createTask(request, env);
    if (url.pathname === "/v1/tasks/approve") return approveTask(request, env);
    if (url.pathname === "/v1/tasks/cancel") return cancelTask(request, env);
    if (url.pathname === "/v1/tasks/take") return takeTask(request, env);
    if (url.pathname === "/v1/tasks/delete") return deleteTask(request, env);
    if (url.pathname === "/v1/tasks/feed") return feedTasks(request, env);
    // A89: the Mac's browser loop records each step it takes.
    if (url.pathname === "/v1/tasks/step") return stepTask(request, env);
    // A89 §11: a browser step's model call — its own route, counter and
    // allowlist, so /v1/ask is exactly what it was.
    if (url.pathname === "/v1/tasks/ask") return askStep(request, env, ctx, t0);
    if (url.pathname === "/v1/tasks") return listTasks(request, env);

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
      // A REJECTION IS CLASSIFIED, AND ITS WORDS ARE NOT KEPT: the error
      // body's type and the status are logged (an outage shows its cause),
      // the message is never logged or forwarded (upstreamRefusal).
      return upstreamRefusal(upstream, "question");
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
        // `otto-tasks` (A82), from the KV summary checkLimits already read
        // beside the counters. Absent when there is no summary: the app
        // reads absence as "no information", never as "no tasks".
        ...gate.tasks,
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
  const { dayKey, hourKey, totalKey, tasksKey } = counterKeys(account.subject, now);
  const onTrial = account.kind === "trial" && account.trialCap > 0;

  // THE TASK SUMMARY RIDES IN THE SAME ROUND TRIP (A82). One more KV key,
  // read beside the counters inside the one Promise.all, so a question
  // learns of a finished task with no new request, no new binding and no
  // added latency — at KV's sixty-second edge cache, which A26 records. READ
  // AND NEVER WRITTEN HERE: the Workflow and the task routes rewrite it from
  // D1, and Bench/check-task-path.sh asserts this function has no put of it.
  // A trial has no account and so no tasks; its read is skipped.
  const tRead = Date.now();
  const [dayRaw, hourRaw, totalRaw, tasksRaw] = await Promise.all([
    env.OTTO.get(dayKey),
    env.OTTO.get(hourKey),
    onTrial ? env.OTTO.get(totalKey) : Promise.resolve(null),
    onTrial ? Promise.resolve(null) : env.OTTO.get(tasksKey),
  ]);
  timing.counterRead = Date.now() - tRead;
  const dayCount = Number(dayRaw) || 0;
  const hourCount = Number(hourRaw) || 0;
  const totalCount = Number(totalRaw) || 0;
  let tasks = {};
  if (tasksRaw) {
    try { tasks = tasksHeader(JSON.parse(tasksRaw)); } catch { tasks = {}; }
  }

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
    return { refused: problem(403, "trial_exhausted", {}, { ...usage(false), ...tasks }) };
  }

  if (account.hourlyCap > 0 && hourCount >= account.hourlyCap) {
    return {
      refused: problem(429, "hourly_limit",
                       { retryAfter: secondsToNextHour(now) }, { ...usage(false), ...tasks }),
    };
  }
  if (account.dailyCap > 0 && dayCount >= account.dailyCap) {
    return {
      refused: problem(429, "daily_limit",
                       { retryAfter: secondsToNextDay(now) }, { ...usage(false), ...tasks }),
    };
  }

  timing.counterWrite = 0;   // no longer on the critical path
  return {
    refused: null,
    usage: usage(true),
    tasks,
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
    // The account's task summary (A82): written by the Workflow and the task
    // routes, read by the question path. The one `tasks:` literal in this file.
    tasksKey: `tasks:${subject}`,
    // The task day counter (A82), the shape of the tool counter in runTool.
    taskDayKey: `u:${subject}:k:${day}`,
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
    `SELECT app, connected_account_id, state, updated_at, connected_at, defaults FROM integrations WHERE account_id = ?`
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
  // Both headers on every tool reply: the apps' states, and the tasks' (A82),
  // exact from D1 on a route that already reads it.
  const headers = { ...integrationsHeader(rows), ...(await safeTasksHeader(env, accountId)) };
  const row = rows.find((r) => r.app === spec.app);
  if (!row || row.state !== "active") {
    return problem(403, "needs_signin", { app: spec.app }, headers);
  }

  // The arguments, with the connection's defaults filled in (A77). A
  // default the user never said and the row does not hold — which
  // repository, project or team — is `needs_detail` with a hint Otto speaks.
  let defaults = null;
  try { defaults = row.defaults ? JSON.parse(row.defaults) : null; } catch { defaults = null; }
  let args;
  try {
    args = composioArguments(tool, body.input, now, tz, defaults);
  } catch (error) {
    if (error instanceof NeedsDetail) return problem(400, "needs_detail", { hint: error.hint }, headers);
    throw error;
  }
  if (!args) return problem(400, "unknown_tool", {}, headers);

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
                     { ...headers, ...integrationsHeader(rows.map((r) => (r.app === spec.app ? { ...r, state: "expired" } : r))) });
    }
    // CLASSIFIED ON THE NUMBER, NEVER THE TEXT (A58's rule; A77, from the
    // first run). Composio's `data.status_code` is the app's own HTTP status:
    // a 404 is the app saying the repository, project or page is not there,
    // which is a different sentence from "the connector failed". The free
    // text can quote the arguments and is neither read for this nor logged.
    const status = reply.json && reply.json.data && Number(reply.json.data.status_code);
    const reason = status === 404 ? "not_found" : status === 403 ? "forbidden"
                 : status === 422 ? "rejected" : "connector";
    console.error(`tool ${tool}: connector answered HTTP ${reply.status}, successful=${ok}, app status ${status || "none"}`);
    return problem(502, "tool_failed", { reason }, headers);
  }

  const { result, id } = compact(tool, reply.json.data);
  console.log(`tool ${tool} ran for ${spec.app}`);
  return json200({ ok: true, result, id }, headers);
}

/** The plan row with its tool and task caps. Never called from the question path. */
async function loadPlanCaps(env, name) {
  try {
    return await env.DB.prepare(
      `SELECT name, daily_cap, hourly_cap, trial_cap, tool_cap, task_cap FROM plans WHERE name = ?`
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
        `INSERT INTO integrations (account_id, app, connected_account_id, state, updated_at, connected_at, defaults)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(account_id, app) DO UPDATE SET
           connected_account_id = excluded.connected_account_id,
           state = excluded.state, updated_at = excluded.updated_at,
           connected_at = NULL, defaults = NULL`
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
 * The row becomes active: `connected_at` is set the first time only, so the
 * header's order is the order of first connection, and the defaults are
 * written (A77).
 */
async function activateIntegration(env, accountId, app, defaults) {
  try {
    await env.DB.prepare(
      `UPDATE integrations SET state = 'active', updated_at = ?,
         connected_at = COALESCE(connected_at, ?), defaults = ?
       WHERE account_id = ? AND app = ?`
    ).bind(Date.now(), Date.now(), defaults ? JSON.stringify(defaults) : null, accountId, app).run();
  } catch (error) {
    console.error("integration row not activated:", String(error && error.message));
  }
}

/**
 * The defaults for an app, from its lookups (tools.js says which). Null
 * for an app with none, or when a lookup fails — logged by app and status,
 * never by content.
 */
async function connectDefaults(env, app, accountId, connectedAccountId) {
  const lookups = DEFAULT_LOOKUPS[app];
  if (!lookups || !lookups.length) return null;
  const replies = [];
  for (const lookup of lookups) {
    const reply = await composio(env, "POST", `/tools/execute/${lookup.slug}`, {
      user_id: accountId,
      connected_account_id: connectedAccountId,
      arguments: lookup.arguments,
    });
    const ok = !reply.unavailable && reply.status === 200 && reply.json && reply.json.successful === true;
    if (!ok) {
      console.error(`defaults for ${app}: lookup answered HTTP ${reply.status || "none"}`);
      return null;
    }
    replies.push(reply.json.data);
  }
  console.log(`defaults recorded for ${app}`);
  return defaultsFromReplies(app, replies);
}

/**
 * POST /v1/integrations  →  200 { apps: { gmail, gcal, slack, … } } + otto-integrations
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
  // The panel opens on this request (A78), so it is where a finished task
  // reaches a user who has not asked a question since (A82).
  return json200({ apps, account: true },
                 { ...integrationsHeader(rows), ...(await safeTasksHeader(env, auth.account.subject)) });
}

/**
 * POST /v1/integrations/link  { app }  →  200 { url }
 *
 * Asks Composio for a hosted sign-in link for this account and app, under the
 * managed auth config named in [vars], and records the pending row so the
 * callback can recognise the authorization when the browser comes back. The
 * link expires at Composio's ten minutes; Otto opens it at once.
 *
 * Jira's docs say its connection needs `connection_data.subdomain`; A77
 * (decision 2) tries the link WITHOUT it first, since the hosted flow may
 * take the site from Atlassian's own picker, and adds a site field only if
 * the first manual run shows it is required.
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
    case "gmail":  return env.COMPOSIO_AUTH_CONFIG_GMAIL || null;
    case "gcal":   return env.COMPOSIO_AUTH_CONFIG_GCAL || null;
    case "slack":  return env.COMPOSIO_AUTH_CONFIG_SLACK || null;
    case "github": return env.COMPOSIO_AUTH_CONFIG_GITHUB || null;
    case "gitlab": return env.COMPOSIO_AUTH_CONFIG_GITLAB || null;
    case "jira":   return env.COMPOSIO_AUTH_CONFIG_JIRA || null;
    case "gdrive": return env.COMPOSIO_AUTH_CONFIG_GDRIVE || null;
    case "notion": return env.COMPOSIO_AUTH_CONFIG_NOTION || null;
    case "linear": return env.COMPOSIO_AUTH_CONFIG_LINEAR || null;
    default:       return null;
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
        // CONNECT-TIME DEFAULTS (A77): the values a spoken request never
        // carries, looked up once now and stored on the row. One or two
        // Composio calls here, never at question time; a failure leaves
        // the row active with no defaults, and the tool asks for the
        // detail instead.
        const defaults = await connectDefaults(env, row.app, row.account_id, id);
        await activateIntegration(env, row.account_id, row.app, defaults);
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

// -------------------------------------------------------------------- tasks

/**
 * Long-running tasks (SPEC.md A82): six routes, none of them the question
 * path. A task is a D1 row and a Workflow instance with the same id; the row
 * is the truth, the instance is the engine, and src/tasks/run.js is what
 * passes between them. The task routes write the row, speak to the instance
 * (create, sendEvent, terminate, delete) and rewrite the KV summary; the
 * Workflow does the same from inside its steps.
 *
 * WHO A TASK BELONGS TO: the account subject, as a tool does. A trial device
 * is refused with `needs_account` before anything is read. Every row read
 * names the account, so another account's id is `not_found`.
 *
 * WHAT IS NEVER LOGGED: the request, the context, the document, the
 * question, the result. Lines carry a type, a state, a reason word.
 */

/** The task header for a route that already reads D1. A D1 failure here loses the header, not the reply. */
async function safeTasksHeader(env, accountId) {
  try { return await tasksHeaderFor(env, accountId); } catch (error) {
    console.error(`task header not computed (${error && error.name ? error.name : "error"})`);
    return {};
  }
}

/**
 * POST /v1/tasks/create  { type, request, context?, document?, now, tz }  →  200 { id, state: "created" } + otto-tasks
 *
 * In order: the bearer must have an account; the body must carry only the
 * six allowed keys — an allowlist, so an image never arrives under a name of
 * its own (A60); the type must be in the registry and the request bounded;
 * the document only for a type that declares it; the task counter under the
 * plan's cap, counted BEFORE the create so a create that fails still counts;
 * then the row, then the instance with the same id and the same retention
 * the row has.
 */
async function createTask(request, env) {
  const auth = await authenticateAccount(request, env);
  if (auth.refused) return auth.refused;
  const accountId = auth.account.subject;

  let body;
  try { body = await request.json(); } catch { return problem(400, "malformed_json"); }
  if (!body || typeof body !== "object") return problem(400, "bad_request");
  for (const key of Object.keys(body)) if (!CREATE_KEYS.includes(key)) return problem(400, "bad_request", { key });

  const type = typeof body.type === "string" ? body.type : "";
  const entry = TYPES[type];
  if (!entry) return problem(400, "unknown_type");

  const text = typeof body.request === "string" ? body.request.trim() : "";
  if (!text || text.length > REQUEST_MAX_CHARS) return problem(400, "bad_request", { field: "request" });
  if (body.title !== undefined && typeof body.title !== "string") return problem(400, "bad_request", { field: "title" });
  // The model's short title (A91), bounded to six words; a create without
  // one is named by its request, cut at a word boundary.
  const title = cleanTitle(body.title) || fallbackTitle(text);
  // A BROWSER TASK'S MODE AND START PAGE (A89), and for no other type. The
  // mode is fixed here for good — no route changes the input — and unclear
  // is read. The page is kept without its query or fragment: the host names
  // the approval card's source, and a query is no business of the ledger.
  let browser = null;
  if (entry.needsUrl) {
    const mode = body.mode === undefined ? "read" : body.mode;
    if (!BROWSER_MODES.includes(mode)) return problem(400, "bad_request", { field: "mode" });
    let start;
    try { start = new URL(typeof body.url === "string" && body.url.length <= URL_MAX_CHARS ? body.url : ""); } catch { start = null; }
    if (!start || start.protocol !== "https:" || !start.hostname) return problem(400, "bad_request", { field: "url" });
    browser = { mode, url: `${start.origin}${start.pathname}`, host: start.hostname };
  } else if (body.mode !== undefined || body.url !== undefined) {
    return problem(400, "bad_request", { field: body.mode !== undefined ? "mode" : "url" });
  }
  const context = typeof body.context === "string" ? body.context.trim().slice(0, CONTEXT_MAX_CHARS) : "";
  const now = typeof body.now === "string" && !Number.isNaN(new Date(body.now).getTime()) ? body.now : null;
  if (!now) return problem(400, "bad_request", { field: "now" });
  const tz = typeof body.tz === "string" && body.tz ? body.tz.slice(0, 64) : "UTC";
  let document;
  if (body.document !== undefined) {
    if (!entry.needsDocument) return problem(400, "document_not_allowed");
    if (typeof body.document !== "string" || new TextEncoder().encode(body.document).byteLength > DOCUMENT_MAX_BYTES) {
      return problem(400, "document_not_allowed");
    }
    document = body.document;
  }

  if (!env.TASKS) {
    console.error("tasks are not provisioned: the TASKS binding is missing");
    return problem(503, "not_provisioned");
  }

  // The task cap, from the plan row, counted before the create (like tools).
  const plan = await loadPlanCaps(env, auth.account.plan);
  const taskCap = plan ? Number(plan.task_cap) || 0 : 0;
  const { taskDayKey } = counterKeys(accountId, new Date());
  const used = Number(await env.OTTO.get(taskDayKey)) || 0;
  // The day is UTC (counterKeys), so the cap resets at the next UTC midnight;
  // the app says when in the user's own clock (A91).
  const resetsAt = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1);
  if (taskCap > 0 && used >= taskCap) return problem(429, "task_limit", { cap: taskCap, resetsAt }, await safeTasksHeader(env, accountId));
  await env.OTTO.put(taskDayKey, String(used + 1), { expirationTtl: 60 * 60 * 48 });

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const input = { request: text, title, ...(browser || {}), ...(context ? { context } : {}), ...(document !== undefined ? { document } : {}), now, tz, taskVersion: TASK_VERSION };
  try {
    await insertRow(env, { id, accountId, type, input, createdAt });
  } catch (error) {
    console.error("task row not written:", String(error && error.name || "error"));
    return problem(503, "not_provisioned");
  }

  // THE INSTANCE, with the row's id and the row's retention. If the platform
  // refuses, the row goes: a task the user cannot see must not linger.
  try {
    await env.TASKS.create({
      id,
      params: { type, accountId, input, taskVersion: TASK_VERSION },
      retention: { successRetention: entry.retention, errorRetention: entry.retention },
    });
  } catch (error) {
    console.error(`task instance not created for ${type} (${error && error.name ? error.name : "error"})`);
    await deleteRow(env, { id, accountId });
    return problem(502, "task_not_started", {}, await safeTasksHeader(env, accountId));
  }
  await writeSummary(env, accountId);
  console.log(`task ${type} created`);
  return json200({ id, state: "created" }, await safeTasksHeader(env, accountId));
}

/**
 * POST /v1/tasks/step  { id, n, kind, label?, sentence?, answer?, reason? }  →  200 { id, n, state } + otto-tasks
 *
 * A89: the Mac's browser loop records the step it just took. The ledger is
 * the row; the instance is told only that a step was posted, and reads the
 * row to act on it (src/tasks/browser.js says why).
 *
 * WHAT THE LEDGER MAY HOLD, AND NOTHING ELSE: a label for each step, the
 * extension's sentence for an approval, the final answer, and a reason word
 * for an end. The body is an allowlist of seven keys under 2 KB, so page
 * text has no name to arrive under and no room if it found one; every string
 * is cleaned of invisible characters and of any URL's query or fragment.
 *
 * In order: the bearer must have an account; the task must be the account's
 * own browser task, not finished; the step must be the next one, at most the
 * twenty-fifth, inside thirty minutes of working time; an approval only in a
 * task started to act; then the row, then the event.
 */
async function stepTask(request, env) {
  const auth = await authenticateAccount(request, env);
  if (auth.refused) return auth.refused;
  const declared = Number(request.headers.get("content-length"));
  if (declared > STEP_BODY_MAX_BYTES) return problem(413, "body_too_large");
  let body;
  try {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > STEP_BODY_MAX_BYTES) return problem(413, "body_too_large");
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return problem(400, "malformed_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return problem(400, "bad_request");
  for (const key of Object.keys(body)) if (!STEP_KEYS.includes(key)) return problem(400, "bad_request", { key });

  const id = typeof body.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(body.id) ? body.id : "";
  if (!id) return problem(400, "bad_request", { field: "id" });
  const n = Number.isInteger(body.n) ? body.n : 0;
  if (n < 1) return problem(400, "bad_request", { field: "n" });
  const kind = STEP_KINDS.includes(body.kind) ? body.kind : "";
  if (!kind) return problem(400, "bad_request", { field: "kind" });
  const label = typeof body.label === "string" ? ledgerText(body.label, STEP_LABEL_MAX) : "";
  const sentence = typeof body.sentence === "string" ? ledgerText(body.sentence, STEP_SENTENCE_MAX) : "";
  const answer = typeof body.answer === "string" ? ledgerText(body.answer, SPOKEN_MAX_CHARS) : "";
  if ((kind === "step" || kind === "approval") && !label) return problem(400, "bad_request", { field: "label" });
  if (kind === "approval" && !sentence) return problem(400, "bad_request", { field: "sentence" });
  if (kind === "finish" && !answer) return problem(400, "bad_request", { field: "answer" });
  if (kind === "end" && !BROWSER_END_REASONS[body.reason]) return problem(400, "bad_request", { field: "reason" });

  const task = { id, accountId: auth.account.subject };
  let row;
  try { row = await readRow(env, task); } catch (error) {
    console.error("task row unreadable:", String(error && error.name || "error"));
    return problem(503, "not_provisioned");
  }
  // ANOTHER ACCOUNT'S TASK IS NOT FOUND: every read names the account.
  if (!row) return problem(404, "not_found");
  if (row.type !== "browser") return problem(400, "not_browser");
  if (TERMINAL.has(row.state)) return problem(409, "already_finished", { state: row.state }, await safeTasksHeader(env, task.accountId));

  // AN END IS ALWAYS TAKEN while the task is alive, even waiting for a yes:
  // the user closed the tab, Chrome quit, Otto quit. The instance is ended
  // here, as a cancel is; a stop the user made is seen at once (A82).
  if (kind === "end") {
    await terminateInstance(env, task.id);
    const byUser = body.reason === "user_closed_tab" || body.reason === "user_stopped";
    await finishTask(env, task, byUser ? "cancelled" : "failed", { reason: body.reason, seen: byUser });
    console.log(`task browser ended: ${body.reason}`);
    return json200({ id, n, state: byUser ? "cancelled" : "failed" }, await safeTasksHeader(env, task.accountId));
  }
  if (row.state === "awaiting_approval") return problem(409, "awaiting_approval", {}, await safeTasksHeader(env, task.accountId));

  let input = {};
  try { input = JSON.parse(row.input || "{}"); } catch { input = {}; }
  // THE MODE NEVER CHANGES (A89 §5): a task started to read cannot ask to act.
  if (kind === "approval" && input.mode !== "act") return problem(409, "read_only", {}, await safeTasksHeader(env, task.accountId));

  const steps = stepsOf(row);
  if (n !== steps.length + 1) return problem(409, "out_of_order", { expected: steps.length + 1 }, await safeTasksHeader(env, task.accountId));
  const elapsed = Date.now() - Number(row.created_at) - (Number(row.waited_ms) || 0);
  const limit = n > BROWSER_MAX_STEPS ? "step_limit" : elapsed > TYPES.browser.maxDurationMs ? "max_duration" : "";
  if (limit) {
    // THE BOUND ENDS THE TASK, not only the step: the loop is told why.
    await terminateInstance(env, task.id);
    await finishTask(env, task, "failed", { reason: limit });
    console.log(`task browser ended: ${limit}`);
    return problem(409, limit, {}, await safeTasksHeader(env, task.accountId));
  }

  const entry = {
    name: `step-${n}`, kind, ended: Date.now(), outcome: "ok",
    ...(label ? { label } : {}),
    ...(kind === "approval" ? { ask: sentence } : {}),
    ...(kind === "finish" ? { answer, label: label || "Done" } : {}),
  };
  try {
    await appendStep(env, task, row, entry);
  } catch (error) {
    // Two posts of one step: the ledger moved under this one, so it is late.
    if (error && error.name === "LedgerConflict") return problem(409, "out_of_order", {}, await safeTasksHeader(env, task.accountId));
    console.error("task step not written:", String(error && error.name || "error"));
    return problem(503, "not_provisioned");
  }
  try {
    const instance = await env.TASKS.get(task.id);
    // NOTHING BUT "A STEP WAS POSTED": the instance reads the row.
    await instance.sendEvent({ type: "browser-step", payload: { n } });
  } catch (error) {
    console.error(`task step not delivered (${error && error.name ? error.name : "error"})`);
    await finishTask(env, task, "failed", { reason: "step_failed" });
    return problem(502, "task_failed", {}, await safeTasksHeader(env, task.accountId));
  }
  return json200({ id, n, state: row.state }, await safeTasksHeader(env, task.accountId));
}

/**
 * POST /v1/tasks/ask  (a Messages body, as /v1/ask takes it)
 *   + otto-task: <id>, otto-step: <n>  →  200 text/event-stream, passed through
 *
 * A89 §11: the model call for step n of a browser task. NOT /v1/ask, so the
 * question path, its counters and its allowlist are exactly what they were;
 * and not a header on /v1/ask, which would have put a task read on that path
 * or trusted a KV copy up to a minute stale.
 *
 * WHY IT CANNOT CARRY ORDINARY QUESTIONS. A call lands only for the account's
 * own browser task that is alive and not waiting for a yes, for the next step
 * the ledger expects, inside the task's thirty minutes, under thirty calls a
 * task (counted on the row in the same statement that checks it) and under
 * the plan's step_cap a day. So the most a free account can get through here
 * is step_cap calls a day, each spent inside a task it started, which counts
 * on the task cap — not a way round the question counter.
 *
 * In order: the bearer must have an account; the headers must name a task and
 * a step; the body is bounded and validated as a question's is, against
 * STEP_MODELS; then ONE round of reads in parallel — the row's count and
 * check, the plan's step_cap, the day's counter — then the stream. The D1
 * time is reported in server-timing as `d1`, so the cost of that round is
 * measured on every call rather than argued.
 */
async function askStep(request, env, ctx, t0 = Date.now()) {
  const auth = await authenticateAccount(request, env);
  if (auth.refused) return auth.refused;
  const accountId = auth.account.subject;
  const id = request.headers.get("otto-task") || "";
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return problem(400, "bad_request", { field: "otto-task" });
  const n = Number(request.headers.get("otto-step"));
  if (!Number.isInteger(n) || n < 1) return problem(400, "bad_request", { field: "otto-step" });

  // Bounded before it is parsed, as the question is.
  const maxBody = Number(env.MAX_BODY_BYTES) || 6_000_000;
  if (Number(request.headers.get("content-length")) > maxBody) return problem(413, "body_too_large");
  let body;
  try {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > maxBody) return problem(413, "body_too_large");
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return problem(400, "malformed_json");
  }
  const rejection = validate(body, env, STEP_MODELS);
  if (rejection) return rejection;

  const task = { id, accountId };
  const now = new Date(Date.now());
  const stepDayKey = `u:${accountId}:s:${now.toISOString().slice(0, 10)}`;
  const tD1 = Date.now();
  let counted, plan, used;
  try {
    [counted, plan, used] = await Promise.all([
      countCall(env, task, BROWSER_MAX_CALLS),
      env.DB.prepare(`SELECT step_cap FROM plans WHERE name = ?`).bind(auth.account.plan).first(),
      env.OTTO.get(stepDayKey),
    ]);
  } catch (error) {
    console.error("browser step call not counted:", String(error && error.name || "error"));
    return problem(503, "not_provisioned");
  }
  const d1Ms = Date.now() - tD1;
  // FAILS CLOSED: no plan row, or no step_cap column, is no call.
  if (!plan || plan.step_cap === undefined || plan.step_cap === null) return problem(503, "not_provisioned");

  if (!counted) return refuseStepCall(env, task);
  const ended = async (reason, status, code, extra = {}) => {
    await terminateInstance(env, task.id);
    await finishTask(env, task, "failed", { reason });
    console.log(`task browser ended: ${reason}`);
    return problem(status, code, extra, await safeTasksHeader(env, accountId));
  };
  const expected = stepsOf(counted).length + 1;
  if (n !== expected) return problem(409, "out_of_order", { expected });
  if (Date.now() - Number(counted.created_at) - (Number(counted.waited_ms) || 0) > TYPES.browser.maxDurationMs) {
    return ended("max_duration", 409, "max_duration");
  }
  const stepCap = Number(plan.step_cap) || 0;
  const today = Number(used) || 0;
  if (stepCap > 0 && today >= stepCap) {
    const resetsAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return ended("step_cap", 429, "step_limit", { cap: stepCap, resetsAt });
  }
  // Off the critical path, as the question's increment is; the per-task
  // bound above is the exact one, this is the day's.
  defer(ctx, env.OTTO.put(stepDayKey, String(today + 1), { expirationTtl: 60 * 60 * 48 }), "step counter increment");

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
  if (!upstream.ok) return upstreamRefusal(upstream, "browser step");
  const upstreamMs = Date.now() - beforeUpstream;
  // PASS-THROUGH, as the question's stream is: the body is handed on
  // untouched, never read, buffered or counted here.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "otto-steps": `${today + 1}/${stepCap}; calls=${counted.calls}/${BROWSER_MAX_CALLS}`,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      "connection": "keep-alive",
      "server-timing": [
        `d1;dur=${d1Ms}`,
        `upstream;dur=${upstreamMs}`,
        `relay;dur=${Date.now() - t0 - upstreamMs}`,
      ].join(", "),
    },
  });
}

/** Why a browser step's call was not counted, read from the row. */
async function refuseStepCall(env, task) {
  let row;
  try { row = await readRow(env, task); } catch (error) {
    console.error("task row unreadable:", String(error && error.name || "error"));
    return problem(503, "not_provisioned");
  }
  // ANOTHER ACCOUNT'S TASK IS NOT FOUND, as on every task route.
  if (!row) return problem(404, "not_found");
  if (row.type !== "browser") return problem(400, "not_browser");
  const headers = await safeTasksHeader(env, task.accountId);
  if (TERMINAL.has(row.state)) return problem(409, "already_finished", { state: row.state }, headers);
  if (row.state === "awaiting_approval") return problem(409, "awaiting_approval", {}, headers);
  if ((Number(row.calls) || 0) >= BROWSER_MAX_CALLS) {
    // THE BOUND ENDS THE TASK, as the step bound does.
    await terminateInstance(env, task.id);
    await finishTask(env, task, "failed", { reason: "call_limit" });
    console.log("task browser ended: call_limit");
    return problem(409, "call_limit", {}, await safeTasksHeader(env, task.accountId));
  }
  return problem(409, "not_running", { state: row.state }, headers);
}

/** The row named in the body, for this account, or the refusal. */
async function taskFromBody(request, env) {
  const auth = await authenticateAccount(request, env);
  if (auth.refused) return { refused: auth.refused };
  let body;
  try { body = await request.json(); } catch { return { refused: problem(400, "malformed_json") }; }
  const id = body && typeof body.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(body.id) ? body.id : "";
  if (!id) return { refused: problem(400, "bad_request", { field: "id" }) };
  const task = { id, accountId: auth.account.subject };
  let row;
  try { row = await readRow(env, task); } catch (error) {
    console.error("task row unreadable:", String(error && error.name || "error"));
    return { refused: problem(503, "not_provisioned") };
  }
  if (!row) return { refused: problem(404, "not_found") };
  return { auth, body, task, row };
}

/**
 * POST /v1/tasks/approve  { id, decision: "approve" | "decline" }  →  200 { id, state } + otto-tasks
 *
 * Only a row that is awaiting may be answered; the answer is written, then
 * the event is sent to the instance, which is waiting on exactly this type.
 * If the instance cannot take it, the row is failed rather than left saying
 * "approved" over a Workflow that will never move.
 */
async function approveTask(request, env) {
  const found = await taskFromBody(request, env);
  if (found.refused) return found.refused;
  const { body, task, row } = found;
  const decision = body.decision === "approve" || body.decision === "decline" ? body.decision : "";
  if (!decision) return problem(400, "bad_request", { field: "decision" });
  if (row.state !== "awaiting_approval") return problem(409, "not_awaiting", { state: row.state }, await safeTasksHeader(env, task.accountId));

  const state = decision === "approve" ? "approved" : "declined";
  // A decline ends the task by the user's own word, so it is seen as well.
  await markState(env, task, state, { answer: { decision, at: Date.now() }, seen: decision === "decline" });
  try {
    const instance = await env.TASKS.get(task.id);
    await instance.sendEvent({ type: "approval", payload: { decision } });
  } catch (error) {
    console.error(`task approval not delivered (${error && error.name ? error.name : "error"})`);
    await finishTask(env, task, "failed", { reason: "step_failed" });
    return problem(502, "task_failed", {}, await safeTasksHeader(env, task.accountId));
  }
  console.log(`task ${row.type} ${state}`);
  return json200({ id: task.id, state }, await safeTasksHeader(env, task.accountId));
}

/**
 * POST /v1/tasks/cancel  { id }  →  200 { id, state: "cancelled" } + otto-tasks
 *
 * The instance is terminated, best effort, and the row says the user did it.
 */
async function cancelTask(request, env) {
  const found = await taskFromBody(request, env);
  if (found.refused) return found.refused;
  const { task, row } = found;
  if (TERMINAL.has(row.state)) return problem(409, "already_finished", { state: row.state }, await safeTasksHeader(env, task.accountId));
  await terminateInstance(env, task.id);
  // SEEN BY THE USER WHO CANCELLED IT (A82, from the app's design): the row
  // would otherwise ride the next header as unseen and be announced back.
  await finishTask(env, task, "cancelled", { reason: "user", seen: true });
  console.log(`task ${row.type} cancelled`);
  return json200({ id: task.id, state: "cancelled" }, await safeTasksHeader(env, task.accountId));
}

/**
 * POST /v1/tasks/take  { id }  →  200 { id, type, state, reason?, result?, steps } + otto-tasks
 *
 * The one request the delivering chord causes: the detail no header could
 * carry, the row marked seen, and the instance deleted — the result is in the
 * row now, so the platform's copy has nothing left to do.
 */
async function takeTask(request, env) {
  const found = await taskFromBody(request, env);
  if (found.refused) return found.refused;
  const { task, row } = found;
  if (!TERMINAL.has(row.state)) return problem(409, "not_finished", { state: row.state }, await safeTasksHeader(env, task.accountId));
  await markSeen(env, task);
  await deleteInstance(env, task.id);
  let result = null;
  try { result = row.result ? JSON.parse(row.result) : null; } catch { result = null; }
  let steps = [];
  try { steps = JSON.parse(row.steps || "[]"); } catch { steps = []; }
  const ledger = (Array.isArray(steps) ? steps : []).map((s) => ({ name: s.name, outcome: s.outcome, cents: s.cents ?? 0 }));
  console.log(`task ${row.type} taken (${row.state})`);
  return json200({ id: task.id, type: row.type, state: row.state, reason: row.reason || undefined, result, steps: ledger },
                 await safeTasksHeader(env, task.accountId));
}

async function markSeen(env, task) {
  await env.DB.prepare(`UPDATE tasks SET seen_at = ?, updated_at = ? WHERE id = ? AND account_id = ?`)
    .bind(Date.now(), Date.now(), task.id, task.accountId).run();
  await writeSummary(env, task.accountId);
}

/**
 * POST /v1/tasks/delete  { id }  →  200 {} + otto-tasks
 *
 * The user's deletion: a running instance is terminated first, then the row
 * and the instance go. Retention does the same on its own clock.
 */
async function deleteTask(request, env) {
  const found = await taskFromBody(request, env);
  if (found.refused) return found.refused;
  const { task, row } = found;
  if (!TERMINAL.has(row.state)) await terminateInstance(env, task.id);
  await deleteRow(env, task);
  await deleteInstance(env, task.id);
  await writeSummary(env, task.accountId);
  console.log(`task ${row.type} deleted`);
  return json200({}, await safeTasksHeader(env, task.accountId));
}

/**
 * POST /v1/tasks  {}  →  200 { tasks: [...] } + otto-tasks
 *
 * For the tab (A83): every row of the account, newest first, with the
 * question and the spoken sentence where there is one — never the input,
 * never the detail. Reading the rows is also when retention runs.
 */
async function listTasks(request, env) {
  const auth = await authenticateAccount(request, env);
  if (auth.refused) return auth.refused;
  const accountId = auth.account.subject;
  let rows;
  try { rows = await taskRows(env, accountId); } catch (error) {
    console.error("task rows unreadable:", String(error && error.name || "error"));
    return problem(503, "not_provisioned");
  }
  // The feed's projection (A84): the subject, the steps with their labels,
  // the note's title — never the input beyond its first 120 characters,
  // never the detail.
  const tasks = rows.map(projectRow);
  return json200({ tasks }, await safeTasksHeader(env, accountId));
}

/**
 * POST /v1/tasks/feed  { cursors?: { [id]: lastEventId } }  →  200 text/event-stream + otto-tasks
 *
 * One connection, held while Otto's panel is open (A84): a snapshot of the
 * account's rows, then every step and state change as the platform's event
 * log reports it, projected in src/tasks/feed.js. The body is optional; a
 * reconnecting client sends the last event id it saw per task and the
 * replay starts after it. The stream ends when the client goes.
 */
async function feedTasks(request, env) {
  const auth = await authenticateAccount(request, env);
  if (auth.refused) return auth.refused;
  const accountId = auth.account.subject;
  if (!env.TASKS) {
    console.error("tasks are not provisioned: the TASKS binding is missing");
    return problem(503, "not_provisioned");
  }
  let text = "";
  try { text = await request.text(); } catch { text = ""; }
  let body = {};
  if (text.trim()) {
    try { body = JSON.parse(text); } catch { return problem(400, "malformed_json"); }
  }
  const cursors = {};
  if (body && typeof body === "object" && body.cursors && typeof body.cursors === "object") {
    for (const [id, value] of Object.entries(body.cursors)) {
      if (/^[A-Za-z0-9_-]{1,100}$/.test(id) && Number.isInteger(value) && value >= 0) cursors[id] = value;
    }
  }
  const headers = await safeTasksHeader(env, accountId);
  const stream = openFeed({ env, accountId, cursors, signal: request.signal });
  console.log(`task feed opened (${Object.keys(cursors).length} cursors)`);
  return new Response(stream, {
    status: 200,
    headers: {
      ...headers,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "connection": "keep-alive",
    },
  });
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
function validate(body, env, models = ALLOWED_MODELS) {
  if (typeof body !== "object" || body === null) return problem(400, "bad_request");
  if (!models.has(body.model)) return problem(400, "model_not_allowed");
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
 * WHEN ANTHROPIC REJECTS A CALL. Read only on failure — a successful body is
 * never read here — and only for two facts:
 *   - the error's `type` and the HTTP status, logged, so an outage shows its
 *     cause (2026-10-28: every question failed for want of credit, and the
 *     relay's log said only "400");
 *   - whether it is the provider's side — an outage, overload, rate limit,
 *     the key or the account's billing — which is `provider_unavailable`,
 *     so the app says "I'm having trouble on my end" rather than blaming the
 *     request.
 * The message is matched for billing words and then dropped: never logged,
 * never forwarded. Everything else is `upstream_error`, as before.
 */
export function classifyUpstream(status, text) {
  let type = "unknown", billing = false;
  try {
    const error = (JSON.parse(text) || {}).error || {};
    if (typeof error.type === "string" && /^[a-z_]{1,40}$/.test(error.type)) type = error.type;
    billing = /credit balance|billing|payment|spend limit|usage limit/i.test(String(error.message || ""));
  } catch { /* an unreadable body is "unknown" */ }
  const provider = billing || [401, 403, 429, 500, 502, 503, 504, 529].includes(status)
    || ["overloaded_error", "api_error", "rate_limit_error", "authentication_error", "permission_error", "billing_error"].includes(type);
  return { type, billing, provider };
}

async function upstreamRefusal(upstream, where) {
  let text = "";
  try { text = (await upstream.text()).slice(0, 4096); } catch { text = ""; }
  const { type, billing, provider } = classifyUpstream(upstream.status, text);
  text = "";
  console.error(`upstream refused the ${where}: HTTP ${upstream.status}, ${type}${billing ? ", billing" : ""}`);
  return provider
    ? problem(503, "provider_unavailable", { upstreamStatus: upstream.status })
    : problem(upstream.status, "upstream_error");
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
