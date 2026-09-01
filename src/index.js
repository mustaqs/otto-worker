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
    const gate = await checkLimits(env, token, account, timing);
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

// ---------------------------------------------------------------- accounts

/**
 * A token record. VERSIONED from the first day, because retrofitting a schema
 * version onto records already in production means guessing at record shape.
 *
 *   { v: 1, name, active, dailyCap, hourlyCap }
 *
 * A later version adding { plan, expiresAt, customerId } is then a migration
 * rather than an archaeology exercise.
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
  if (record.v !== 1) return null;
  return {
    active: record.active === true,
    dailyCap: Number(record.dailyCap) || 0,
    hourlyCap: Number(record.hourlyCap) || 0,
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
async function checkLimits(env, token, account, timing = {}) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);          // YYYY-MM-DD
  const hour = now.toISOString().slice(0, 13);         // YYYY-MM-DDTHH

  const dayKey = `u:${token}:d:${day}`;
  const hourKey = `u:${token}:h:${hour}`;

  const tRead = Date.now();
  const [dayRaw, hourRaw] = await Promise.all([
    env.OTTO.get(dayKey),
    env.OTTO.get(hourKey),
  ]);
  timing.counterRead = Date.now() - tRead;
  const dayCount = Number(dayRaw) || 0;
  const hourCount = Number(hourRaw) || 0;

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
  const usage = (inclusive) => ({
    "otto-usage": [
      `day=${dayCount + (inclusive ? 1 : 0)}`,
      `day-cap=${account.dailyCap}`,
      `hour=${hourCount + (inclusive ? 1 : 0)}`,
      `hour-cap=${account.hourlyCap}`,
      `day-resets=${secondsToNextDay(now)}`,
      `hour-resets=${secondsToNextHour(now)}`,
    ].join(";"),
  });

  // The refusal carries the counts too. It is the moment a user most wants to
  // see the bar full, and it means Otto has one place that parses this.
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
      ]),
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
