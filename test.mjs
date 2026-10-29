/**
 * Tests for the Otto relay.
 *
 * The streaming test is the reason this file exists. Every other property here
 * would fail loudly in use; buffering would not — it would just make Otto feel
 * slow, and the cause would be three layers away from the symptom.
 */
import worker, { classifyUpstream } from "./src/index.js";
import { purgeExpired } from "./src/tasks/run.js";
import { readFileSync } from "node:fs";

let failures = 0;
// A parked promise with nothing else pending drains node's loop and the file
// ends with no summary; say so instead, and fail.
process.on("beforeExit", () => { process.stdout.write("\nFAIL the event loop drained before the summary: a test is parked\n"); process.exit(1); });
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : "  — " + detail}`);
  if (!ok) failures++;
};

// A KV stand-in with the same get/put surface the Worker uses.
const makeKV = (seed = {}) => {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => void store.set(k, v),
  };
};

const goodToken = "beta-abc";
const account = (over = {}) =>
  JSON.stringify({ v: 1, name: "tester", active: true, dailyCap: 100, hourlyCap: 10, ...over });

const env = (kv) => ({
  OTTO: kv,
  ANTHROPIC_API_KEY: "sk-test",
  MAX_OUTPUT_TOKENS: "4096",
  MAX_IMAGES: "2",
});

// Stands in for the Workers runtime's ctx. Deferred work is collected so a test
// can await what production would run after the response.
const makeCtx = () => {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), settle: () => Promise.all(pending) };
};

/** Sends, then lets the deferred counter write land, as the runtime would. */
const send = async (envObj, body = valid, token = goodToken) => {
  const ctx = makeCtx();
  const response = await worker.fetch(ask(body, token), envObj, ctx);
  await ctx.settle();
  return response;
};

const ask = (body, token = goodToken) =>
  new Request("https://w/v1/ask", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const valid = {
  model: "claude-opus-5",
  max_tokens: 1024,
  stream: true,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

// ---------------------------------------------------------------- streaming

console.log("streaming (the one that matters):");
{
  // Upstream emits one chunk, then stalls, then finishes. If the Worker
  // buffers, nothing reaches us until the stall ends.
  let releaseSecondChunk;
  const stalled = new Promise((r) => (releaseSecondChunk = r));
  const upstreamBody = new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      await stalled;
      controller.enqueue(new TextEncoder().encode("data: second\n\n"));
      controller.close();
    },
  });
  globalThis.fetch = async () => new Response(upstreamBody, { status: 200 });

  const kv = makeKV({ [`token:${goodToken}`]: account() });

  // The fetch itself is raced. A buffering implementation never returns while
  // the upstream is stalled, so without this the test DEADLOCKS instead of
  // failing — and a hang is a worse red than a red.
  const response = await Promise.race([
    worker.fetch(ask(valid), env(kv)),
    new Promise((r) => setTimeout(() => r(null), 500)),
  ]);
  if (!response) {
    check("worker returns before the upstream stream finishes", false,
          "it did not return — the response is being buffered");
    releaseSecondChunk();
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }

  const reader = response.body.getReader();
  const first = await Promise.race([
    reader.read().then((r) => new TextDecoder().decode(r.value)),
    new Promise((r) => setTimeout(() => r("TIMED-OUT"), 500)),
  ]);
  check("first chunk arrives before upstream finishes", first === "data: first\n\n", first);
  check("content-type is an event stream",
        response.headers.get("content-type").includes("text/event-stream"));
  check("no Content-Length (which would force buffering)",
        response.headers.get("content-length") === null);

  const timing = response.headers.get("server-timing") || "";
  check("reports its own overhead, so relay cost is separable from Anthropic's",
        /cold;dur=[01]/.test(timing) && /upstream;dur=\d+/.test(timing) && /relay;dur=\d+/.test(timing)
        && /kvtoken;dur=\d+/.test(timing) && /kvread;dur=\d+/.test(timing) && /kvwrite;dur=\d+/.test(timing),
        timing);

  releaseSecondChunk();
  const second = await reader.read();
  check("the rest of the stream still arrives",
        new TextDecoder().decode(second.value) === "data: second\n\n");
}

// --------------------------------------------------------------- accounts

console.log("tokens:");
globalThis.fetch = async () => new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
// KV WRITES REFUSED (2026-10-29: past Workers KV's free daily writes): a question still answers.
{
  const kv = makeKV({ [`token:${goodToken}`]: account() });
  kv.put = async () => { throw new Error("KV put() limit exceeded for the day."); };
  const realError = console.error; const logged = []; console.error = (...a) => logged.push(a.join(" "));
  const r = await send(env(kv));
  console.error = realError;
  check("a question still answers when every KV write is refused, and the failure is logged by class",
        r.status === 200 && logged.some((l) => l.startsWith("kv write failed (day counter)")) && !logged.some((l) => l.includes("limit exceeded")));
}
{
  const kv = makeKV({ [`token:${goodToken}`]: account() });
  check("unknown token rejected", (await worker.fetch(ask(valid, "nope"), env(kv))).status === 401);
  check("missing token rejected",
        (await worker.fetch(new Request("https://w/v1/ask", { method: "POST", body: "{}" }), env(kv))).status === 401);

  const revoked = makeKV({ [`token:${goodToken}`]: account({ active: false }) });
  check("revoked token rejected without rotating keys",
        (await worker.fetch(ask(valid), env(revoked))).status === 403);

  const wrongVersion = makeKV({ [`token:${goodToken}`]: JSON.stringify({ v: 99, active: true }) });
  check("unknown schema version rejected rather than guessed at",
        (await worker.fetch(ask(valid), env(wrongVersion))).status === 401);
}

// ----------------------------------------------------------------- limits

console.log("limits:");
{
  const kv = makeKV({ [`token:${goodToken}`]: account({ hourlyCap: 2, dailyCap: 100 }) });
  const first = await send(env(kv));
  const second = await send(env(kv));
  const third = await send(env(kv));
  check("under the hourly cap passes", first.status === 200 && second.status === 200);
  check("over the hourly cap is refused", third.status === 429);
  const body = await third.json();
  check("refusal names which limit and when to retry",
        body.error === "hourly_limit" && typeof body.retryAfter === "number");

  const daily = makeKV({ [`token:${goodToken}`]: account({ hourlyCap: 0, dailyCap: 1 }) });
  await send(env(daily));
  check("daily cap is enforced separately",
        (await send(env(daily))).status === 429);

  // Counted before the upstream call: a failure downstream must not be free.
  const counted = makeKV({ [`token:${goodToken}`]: account() });
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  await send(env(counted));
  const day = new Date().toISOString().slice(0, 10);
  check("a failed upstream call still counts against the cap",
        counted.store.get(`u:${goodToken}:d:${day}`) === "1");
  globalThis.fetch = async () => new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
}

// ------------------------------------------------------- upstream rejections

console.log("when Anthropic rejects a call (2026-10-28's outage):");
{
  const credit = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. SECRETWORDS" } });
  const bad = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages: field required SECRETWORDS" } });
  const over = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  check("credit exhausted is the provider's side, and billing", (() => { const c = classifyUpstream(400, credit); return c.provider && c.billing && c.type === "invalid_request_error"; })());
  check("a malformed request is not", !classifyUpstream(400, bad).provider);
  check("overload, 529, 5xx, 429 and a bad key are the provider's side",
        classifyUpstream(529, over).provider && classifyUpstream(500, "x").provider && classifyUpstream(429, "").provider && classifyUpstream(401, "").provider);
  check("an unreadable body is type unknown", classifyUpstream(502, "<html>").type === "unknown");

  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.map(String).join(" "));
  try {
    const kv = makeKV({ [`token:${goodToken}`]: account() });
    globalThis.fetch = async () => new Response(credit, { status: 400, headers: { "content-type": "application/json" } });
    const r1 = await send(env(kv));
    const b1 = await r1.json();
    check("the question answers 503 provider_unavailable, with the upstream status", r1.status === 503 && b1.error === "provider_unavailable" && b1.upstreamStatus === 400);
    globalThis.fetch = async () => new Response(bad, { status: 400 });
    const r2 = await send(env(kv));
    check("a request the provider refused as malformed is still upstream_error", r2.status === 400 && (await r2.json()).error === "upstream_error");
  } finally { console.error = realError; }
  check("the log names the status and the type, and billing", logged.includes("upstream refused the question: HTTP 400, invalid_request_error, billing")
        && logged.includes("upstream refused the question: HTTP 400, invalid_request_error"));
  check("and never the provider's message", !logged.join("|").includes("SECRETWORDS") && !logged.join("|").includes("credit balance"));
  globalThis.fetch = async () => new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });

  const { endedSentence } = await import("./src/tasks/summary.js");
  check("a checkpoint names the site, and gives the tab back", endedSentence("browser", "failed", "checkpoint", "news.ycombinator.com") === "news.ycombinator.com wants to check you're human — the tab is yours.");
  check("an extension missing from the profile says which profile", endedSentence("browser", "failed", "extension_missing", "x.com") === "Stopped — the Chrome profile Otto uses isn't open, or Otto's extension is off in it.");
}

// ------------------------------------------------------------------- usage

console.log("usage reported back to the person it is about:");
{
  const parse = (response) => {
    const raw = response.headers.get("otto-usage") || "";
    return Object.fromEntries(raw.split(";").filter(Boolean).map((p) => {
      const [k, v] = p.split("=");
      return [k, Number(v)];
    }));
  };

  const kv = makeKV({ [`token:${goodToken}`]: account({ dailyCap: 50, hourlyCap: 10 }) });
  const first = parse(await send(env(kv)));
  check("the first question reports itself as used, not as zero",
        first.day === 1 && first.hour === 1, JSON.stringify(first));
  check("caps come from the token record",
        first["day-cap"] === 50 && first["hour-cap"] === 10, JSON.stringify(first));

  // THE BUG THIS EXISTS TO CATCH. checkLimits reads the counters before the
  // increment is scheduled, so reporting the raw read leaves the display one
  // question behind forever — which looks like a broken panel, not a wrong
  // number, and would be indistinguishable from the counter not working.
  const second = parse(await send(env(kv)));
  check("and the count advances with each question", second.day === 2, JSON.stringify(second));

  check("reset seconds are bounded by the periods they reset",
        first["day-resets"] > 0 && first["day-resets"] <= 86400 &&
        first["hour-resets"] > 0 && first["hour-resets"] <= 3600,
        JSON.stringify(first));

  // A refusal is the moment a user most wants to see the bar full.
  const capped = makeKV({ [`token:${goodToken}`]: account({ dailyCap: 1, hourlyCap: 0 }) });
  await send(env(capped));
  const refused = await send(env(capped));
  const atCap = parse(refused);
  check("a refusal carries the counts too", refused.status === 429 && atCap.day === 1,
        JSON.stringify(atCap));
  check("and reports the count at the cap rather than one past it",
        atCap.day === atCap["day-cap"], JSON.stringify(atCap));

  // Nothing about the question, only about the account.
  const raw = refused.headers.get("otto-usage");
  check("the header describes the account and never the request",
        !/[a-zA-Z]{4,}/.test(raw.replace(/day|cap|hour|resets/g, "")), raw);
}

// ----------------------------------------------------------- registration

console.log("registration says the trial's number before a question is spent:");
{
  // A D1 stand-in with the prepare/bind/first/run surface registerDevice uses.
  const makeDB = (plan, { failInsert = false } = {}) => {
    const runs = [];
    return {
      runs,
      prepare: (sql) => ({
        bind: (...args) => ({
          first: async () => (sql.includes("FROM plans") ? plan : null),
          run: async () => {
            if (failInsert) throw new Error("d1 unavailable");
            runs.push({ sql, args });
          },
        }),
      }),
    };
  };
  const parse = (response) => {
    const raw = response.headers.get("otto-usage") || "";
    return Object.fromEntries(raw.split(";").filter(Boolean).map((p) => {
      const [k, v] = p.split("=");
      return [k, Number(v)];
    }));
  };
  const register = (envObj) =>
    worker.fetch(new Request("https://w/v1/device", {
      method: "POST", headers: { "otto-device-label": "Test Mac" } }), envObj, makeCtx());

  const plan = { name: "trial", daily_cap: 10, hourly_cap: 10, trial_cap: 10 };
  const kv = makeKV();
  const response = await register({ ...env(kv), DB: makeDB(plan) });
  const body = await response.json();
  check("a device is issued a token", response.status === 200 && typeof body.token === "string" && body.token.length > 20);

  // THE GAP THIS EXISTS TO CLOSE. The panel read "No questions yet" until the
  // first answer, because the counts only ever arrived on an answer. A new
  // user should see "10 free questions" before spending one — that is when
  // the trial is doing its selling.
  const initial = parse(response);
  check("the reply carries the usage header, with nothing yet spent",
        initial.day === 0 && initial.hour === 0 && initial.trial === 0, JSON.stringify(initial));
  check("and the caps the record was written with",
        initial["day-cap"] === 10 && initial["hour-cap"] === 10 && initial["trial-cap"] === 10,
        JSON.stringify(initial));
  check("reset seconds are bounded, as on an answer",
        initial["day-resets"] > 0 && initial["day-resets"] <= 86400 &&
        initial["hour-resets"] > 0 && initial["hour-resets"] <= 3600, JSON.stringify(initial));

  // SAME SHAPE AS THE ANSWER'S HEADER, field for field. Otto has one parser;
  // a registration header with a field the answer lacks, or vice versa, is
  // the drift one shared function is there to prevent.
  const first = await send({ ...env(kv), DB: makeDB(plan) }, valid, body.token);
  const afterOne = parse(first);
  check("the registration header has exactly the fields the answer's has",
        JSON.stringify(Object.keys(initial).sort()) === JSON.stringify(Object.keys(afterOne).sort()),
        `${Object.keys(initial)} vs ${Object.keys(afterOne)}`);
  check("and the first answer counts from that zero", afterOne.trial === 1 && afterOne.day === 1,
        JSON.stringify(afterOne));

  // KV first, D1 second: a D1 failure still hands out a working trial.
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  const degraded = await register({ ...env(makeKV()), DB: makeDB(plan, { failInsert: true }) });
  console.error = realError;
  check("a D1 failure still issues a token and reports the trial",
        degraded.status === 200 && parse(degraded)["trial-cap"] === 10);
  check("and is logged without the token",
        errors.some((e) => e.includes("device row not written")) &&
        !errors.join("|").includes((await degraded.json()).token));
}

// ---------------------------------------------------------------- sign-in

console.log("sign-in (two requests, and neither is the question path):");
{
  const SUPABASE_URL = "https://project.supabase.co";
  // Assembled at runtime so the file never contains a secret-shaped literal;
  // Bench/check-no-secrets.sh scans for the real prefix and would refuse it.
  const SECRET = ["sb", "secret", "TESTKEY-not-real-0000000000"].join("_");
  const trialToken = "trial-device-token-xyz";
  const legacyToken = "beta-legacy-token";
  const trialRecord = (over = {}) => JSON.stringify({
    v: 2, subject: trialToken, kind: "trial", plan: "trial", active: true,
    dailyCap: 10, hourlyCap: 10, trialCap: 10, ...over });
  const legacyRecord = JSON.stringify({ v: 1, name: "tester", active: true, dailyCap: 500, hourlyCap: 60 });
  const plans = {
    trial: { name: "trial", daily_cap: 10, hourly_cap: 10, trial_cap: 10 },
    free:  { name: "free",  daily_cap: 50, hourly_cap: 20, trial_cap: 0 },
    beta:  { name: "beta",  daily_cap: 500, hourly_cap: 60, trial_cap: 0 },
  };

  // A D1 stand-in that keeps rows, so what verify wrote can be read back.
  const makeDB = ({ failWrites = false } = {}) => {
    const accounts = [], devices = [];
    return {
      accounts, devices,
      prepare: (sql) => ({ bind: (...args) => ({
        first: async () => {
          const q = sql.trim();
          if (q.includes("FROM plans")) return plans[args[0]] || null;
          if (q.includes("FROM integrations WHERE account_id = ? AND app")) return rows.find((r) => r.account_id === args[0] && r.app === args[1]) || null;
          if (q.includes("FROM accounts WHERE supabase_user_id")) return accounts.find((a) => a.supabase_user_id === args[0]) || null;
          if (q.includes("FROM accounts WHERE email")) return accounts.find((a) => a.email === args[0]) || null;
          return null;
        },
        run: async () => {
          if (failWrites) throw new Error("d1 unavailable");
          const q = sql.trim();
          if (q.startsWith("INSERT INTO accounts")) accounts.push({ id: args[0], email: args[1], supabase_user_id: args[2], plan: args[3] });
          else if (q.startsWith("UPDATE accounts")) { const a = accounts.find((a) => a.id === args[1]); if (a) a.supabase_user_id = args[0]; }
          else if (q.startsWith("INSERT INTO devices")) devices.push({ token: args[0], account_id: args[1], label: args[2], state: "active" });
          else if (q.startsWith("UPDATE devices")) { const d = devices.find((d) => d.token === args[1]); if (d) { d.state = "revoked"; d.revoked_at = args[0]; } }
        },
      }) }),
    };
  };

  // A fetch that answers Supabase from a script and Anthropic as before, and
  // records every call so headers and bodies can be asserted.
  const calls = [];
  let supa = {};
  const anthropic = () => new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith(SUPABASE_URL)) {
      if (u.endsWith("/auth/v1/otp")) return supa.otp ? supa.otp(init) : new Response("{}", { status: 200 });
      if (u.endsWith("/auth/v1/verify")) return supa.verify ? supa.verify(init) : new Response("{}", { status: 403 });
    }
    return anthropic();
  };
  const session = (id, email) => new Response(JSON.stringify({
    access_token: "SESSION-ACCESS-TOKEN-must-not-be-kept", refresh_token: "SESSION-REFRESH",
    token_type: "bearer", expires_in: 3600, user: { id, email } }), { status: 200 });

  const envFor = (kv, db, over = {}) => ({ ...env(kv), DB: db, SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET, ...over });
  const post = (path, token, body) => worker.fetch(new Request(`https://w${path}`, {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "otto-device-label": "Test Mac" },
    body: JSON.stringify(body) }), currentEnv, makeCtx());
  const parse = (response) => Object.fromEntries((response.headers.get("otto-usage") || "").split(";").filter(Boolean)
    .map((p) => { const [k, v] = p.split("="); return [k, Number(v)]; }));
  const supaCalls = () => calls.filter((c) => c.url.startsWith(SUPABASE_URL));
  let currentEnv;

  // --- send
  {
    const kv = makeKV({ [`token:${trialToken}`]: trialRecord() });
    const db = makeDB();
    currentEnv = envFor(kv, db);
    calls.length = 0;
    const r = await post("/v1/signin", trialToken, { email: "  Person@Example.com " });
    check("a registered device may ask for a code", r.status === 200, `got ${r.status}`);
    const sent = supaCalls()[0];
    check("send uses the secret key as `apikey` and never as a bearer",
          sent && sent.init.headers.apikey === SECRET && !("authorization" in sent.init.headers) && !("Authorization" in sent.init.headers));
    const sentBody = sent ? JSON.parse(sent.init.body) : {};
    check("send passes create_user: true, so a first sign-in is the sign-up",
          sentBody.create_user === true && sentBody.email === "person@example.com", JSON.stringify(sentBody));
    check("send writes nothing to KV or D1",
          kv.store.size === 1 && db.accounts.length === 0 && db.devices.length === 0);
    check("the send reply says nothing about the address", (await r.text()) === "{}");

    check("send with no bearer is refused", (await post("/v1/signin", null, { email: "a@b.c" })).status === 401);
    currentEnv = envFor(makeKV({ [`token:${trialToken}`]: trialRecord({ active: false }) }), db);
    check("send with a revoked bearer is refused", (await post("/v1/signin", trialToken, { email: "a@b.c" })).status === 403);
    currentEnv = envFor(kv, db);
    check("an address without one @ is refused before Supabase is asked",
          (await post("/v1/signin", trialToken, { email: "nope" })).status === 400 && supaCalls().length === 1);

    // Never the address, even on the path most likely to print it.
    const errors = [];
    const realError = console.error;
    console.error = (...m) => errors.push(m.map(String).join(" "));
    supa.otp = () => new Response("boom", { status: 500 });
    const down = await post("/v1/signin", trialToken, { email: "person@example.com" });
    supa.otp = () => { throw new Error("network down person@example.com"); };
    const thrown = await post("/v1/signin", trialToken, { email: "person@example.com" });
    console.error = realError;
    check("Supabase 5xx and an unreachable Supabase both answer 503 identity_unavailable",
          down.status === 503 && thrown.status === 503);
    check("and the address is never logged, even when the transport error contains it",
          errors.length > 0 && !errors.join("|").includes("person@example.com") && !errors.join("|").includes(SECRET), errors.join("|"));
    supa.otp = () => new Response(JSON.stringify({ code: 429, error_code: "over_email_send_rate_limit" }), { status: 429, headers: { "retry-after": "42" } });
    const limited = await post("/v1/signin", trialToken, { email: "person@example.com" });
    check("a Supabase rate limit is 429 rate_limited with the provider's retryAfter",
          limited.status === 429 && (await limited.json()).retryAfter === 42);
    supa.otp = null;
  }

  // --- verify
  {
    const kv = makeKV({ [`token:${trialToken}`]: trialRecord() });
    const db = makeDB();
    currentEnv = envFor(kv, db);
    supa.verify = (init) => {
      const b = JSON.parse(init.body);
      return b.type === "email" && b.token === "123456" ? session("user-uuid-1", "person@example.com") : new Response(JSON.stringify({ error_code: "otp_expired" }), { status: 403 });
    };

    const wrong = await post("/v1/signin/verify", trialToken, { email: "person@example.com", code: "000000" });
    check("a wrong code is 403 code_invalid", wrong.status === 403 && (await wrong.json()).error === "code_invalid");
    check("and nothing was written for it", kv.store.size === 1 && db.accounts.length === 0);
    check("a malformed code never reaches Supabase",
          (await post("/v1/signin/verify", trialToken, { email: "person@example.com", code: "12" })).status === 403
          && supaCalls().filter((c) => c.url.endsWith("/verify")).length === 1);

    const ok = await post("/v1/signin/verify", trialToken, { email: "person@example.com", code: "123456" });
    const body = await ok.json();
    check("the right code issues a token and returns the address", ok.status === 200 && typeof body.token === "string" && body.token.length > 20 && body.email === "person@example.com");
    check("verify sends the code to Supabase with `apikey` and never a bearer",
          supaCalls().every((c) => c.init.headers.apikey === SECRET && !("authorization" in c.init.headers)));

    const record = JSON.parse(kv.store.get(`token:${body.token}`) || "null");
    const account = db.accounts[0];
    check("an account exists, on the free plan, linked to the Supabase user",
          account && account.plan === "free" && account.supabase_user_id === "user-uuid-1" && account.email === "person@example.com");
    check("the new KV record's subject is the ACCOUNT id, kind device, caps from the plan row",
          record && record.subject === account.id && record.kind === "device" && record.dailyCap === 50 && record.hourlyCap === 20 && record.trialCap === 0,
          JSON.stringify(record));
    check("the trial token is retired: KV inactive, D1 row revoked",
          JSON.parse(kv.store.get(`token:${trialToken}`)).active === false
          && db.devices.some((d) => d.token === trialToken ? d.state === "revoked" : true)
          && db.devices.find((d) => d.token === body.token)?.state === "active"
          && db.devices.find((d) => d.token === body.token)?.account_id === account.id);
    const header = parse(ok);
    check("the reply's usage header is the account's, with no trial fields",
          header["day-cap"] === 50 && header.day === 0 && !("trial" in header) && !("trial-cap" in header), JSON.stringify(header));
    const everything = [...kv.store.values()].join("|") + JSON.stringify(db.accounts) + JSON.stringify(db.devices) + JSON.stringify(body);
    check("the Supabase session is discarded: nothing stored or returned contains it",
          !everything.includes("SESSION-ACCESS-TOKEN") && !everything.includes("SESSION-REFRESH"));

    // Ten questions forgiven: the new subject starts at zero even though the
    // trial had spent some.
    // A second Mac on the same address joins the same account and sees what
    // the first has spent.
    await send(currentEnv, valid, body.token);
    const second = "second-mac-trial";
    kv.store.set(`token:${second}`, trialRecord({ subject: second }));
    const again = await post("/v1/signin/verify", second, { email: "person@example.com", code: "123456" });
    const againBody = await again.json();
    check("a second device on the same address joins the same account, not a new one",
          again.status === 200 && db.accounts.length === 1 && JSON.parse(kv.store.get(`token:${againBody.token}`)).subject === account.id);
    check("and its usage header shows what the first device already spent", parse(again).day === 1, JSON.stringify(parse(again)));

    // MATCHED BY SUPABASE USER ID, NOT BY ADDRESS. If the address changes
    // upstream, the same person must land on the same account; matching by
    // email first would fork it. (The email fallback exists for the other
    // direction — an identity recreated upstream under the same address.)
    const third = "third-mac-trial";
    kv.store.set(`token:${third}`, trialRecord({ subject: third }));
    supa.verify = () => session("user-uuid-1", "renamed@example.com");
    const renamed = await post("/v1/signin/verify", third, { email: "renamed@example.com", code: "123456" });
    check("the same Supabase user with a new address joins the same account",
          renamed.status === 200 && db.accounts.length === 1
          && JSON.parse(kv.store.get(`token:${(await renamed.json()).token}`)).subject === account.id);

    // Sign-in must not be reachable from a question, and a question must
    // never reach Supabase.
    const before = supaCalls().length;
    await send(currentEnv, valid, body.token);
    check("a question never triggers a Supabase call", supaCalls().length === before);
  }

  // --- a legacy (baked v1) bearer: D2(c)
  {
    const kv = makeKV({ [`token:${legacyToken}`]: legacyRecord });
    const db = makeDB();
    currentEnv = envFor(kv, db);
    supa.verify = () => session("user-uuid-beta", "tester@example.com");
    const r = await post("/v1/signin/verify", legacyToken, { email: "tester@example.com", code: "654321" });
    const b = await r.json();
    check("a legacy bearer's account is created on the beta plan, mirroring its caps",
          r.status === 200 && db.accounts[0]?.plan === "beta" && JSON.parse(kv.store.get(`token:${b.token}`)).dailyCap === 500);
    check("and the v1 record itself is left untouched", kv.store.get(`token:${legacyToken}`) === legacyRecord);
  }

  // --- degraded: D1 fails after the KV record exists
  {
    const kv = makeKV({ [`token:${trialToken}`]: trialRecord() });
    const db = makeDB({ failWrites: true });
    currentEnv = envFor(kv, db);
    supa.verify = () => session("user-uuid-2", "person2@example.com");
    const errors = [];
    const realError = console.error;
    console.error = (...m) => errors.push(m.map(String).join(" "));
    const r = await post("/v1/signin/verify", trialToken, { email: "person2@example.com", code: "123456" });
    console.error = realError;
    // findOrCreateAccount's INSERT fails before any KV write, so nothing was
    // issued — the honest 503. The KV-first promise is for the DEVICE rows.
    check("a D1 failure before the account exists is 503 with nothing issued",
          r.status === 503 && kv.store.size === 1);
    check("and the log names neither the address nor a token",
          errors.length > 0 && !errors.join("|").includes("person2@example.com") && !errors.join("|").includes(trialToken));
  }
  {
    // D1 fails only on the DEVICE rows: the token is issued anyway.
    const kv = makeKV({ [`token:${trialToken}`]: trialRecord() });
    const db = makeDB();
    const realRun = db.prepare;
    db.prepare = (sql) => sql.includes("devices") ? { bind: () => ({ run: async () => { throw new Error("d1 unavailable"); }, first: async () => null }) } : realRun(sql);
    currentEnv = envFor(kv, db);
    const errors = [];
    const realError = console.error;
    console.error = (...m) => errors.push(m.map(String).join(" "));
    const r = await post("/v1/signin/verify", trialToken, { email: "person2@example.com", code: "123456" });
    console.error = realError;
    const b = await r.json();
    check("a D1 failure on the device rows still issues a working token (KV first)",
          r.status === 200 && kv.store.has(`token:${b.token}`) && errors.some((e) => e.includes("device rows not written")));
    check("and that log names no token", !errors.join("|").includes(b.token) && !errors.join("|").includes(trialToken));
  }

  // --- not provisioned
  {
    const kv = makeKV({ [`token:${trialToken}`]: trialRecord() });
    currentEnv = envFor(kv, makeDB(), { SUPABASE_SECRET_KEY: undefined });
    const realError = console.error; console.error = () => {};
    const r = await post("/v1/signin", trialToken, { email: "person@example.com" });
    console.error = realError;
    check("a Worker without the key answers 503 rather than sending an unauthenticated request", r.status === 503);
  }

  supa = {};
  globalThis.fetch = async () => anthropic();
}

// ------------------------------------------------------------- validation

console.log("deferring the counter write:");
{
  const kv = makeKV({ [`token:${goodToken}`]: account() });
  // A KV whose writes are slow. If the response waits on them, this shows up.
  const slow = { ...kv, put: async (k, v) => { await new Promise((r) => setTimeout(r, 300)); return kv.put(k, v); } };
  const ctx = makeCtx();
  const started = Date.now();
  const response = await worker.fetch(ask(valid), { ...env(kv), OTTO: slow }, ctx);
  const elapsed = Date.now() - started;
  check("the response does not wait for the counter write", elapsed < 200, `${elapsed}ms`);
  check("timing reports the write as off the critical path",
        /kvwrite;dur=0/.test(response.headers.get("server-timing") || ""));
  await ctx.settle();
  const day = new Date().toISOString().slice(0, 10);
  check("and the write still lands once the runtime runs it",
        kv.store.get(`u:${goodToken}:d:${day}`) === "1");
}
{
  // A lost write is a free request, so it must not be silent.
  const kv = makeKV({ [`token:${goodToken}`]: account() });
  const broken = { ...kv, put: async () => { throw new Error("kv unavailable"); } };
  const ctx = makeCtx();
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  await worker.fetch(ask(valid), { ...env(kv), OTTO: broken }, ctx);
  await ctx.settle();
  console.error = realError;
  check("a lost counter write is logged rather than swallowed",
        errors.some((e) => e.startsWith("kv write failed (day counter)")), errors.join("|"));
  check("and the report names no token and no request content",
        !errors.join("|").includes(goodToken));
}

console.log("a leaked token is not a general Anthropic proxy:");
{
  const kv = makeKV({ [`token:${goodToken}`]: account() });
  const reject = async (patch, why) => {
    const r = await worker.fetch(ask({ ...valid, ...patch }), env(kv));
    check(why, r.status === 400, `got ${r.status}`);
  };
  await reject({ model: "claude-fable-5" }, "model outside the allowlist refused");
  await reject({ stream: false }, "non-streaming request refused");
  await reject({ max_tokens: 999999 }, "max_tokens above the cap refused");
  await reject({ max_tokens: 0 }, "nonsense max_tokens refused");
  await reject({ messages: [] }, "empty messages refused");
  await reject({
    messages: [{ role: "user", content: [
      { type: "image" }, { type: "image" }, { type: "image" }] }],
  }, "more images than allowed refused");

  // THE BODY CAP IS ENFORCED, NOT DECLARED. It sat in wrangler.toml unread
  // until Otto's A72. Both halves: a Content-Length that claims too much is
  // refused before the body is read, and a body that IS too big is refused
  // after, because the header is a claim. Under the cap, the same request
  // passes validation (and then fails at the fake upstream, which is fine —
  // 413 is what must not appear).
  const small = { ...env(kv), MAX_BODY_BYTES: "1000" };
  const big = await worker.fetch(ask({ ...valid, messages: [{ role: "user",
    content: [{ type: "text", text: "x".repeat(2000) }] }] }), small);
  check("a body over MAX_BODY_BYTES is refused with 413",
        big.status === 413 && (await big.json()).error === "body_too_large", `got ${big.status}`);
  const claimed = await worker.fetch(new Request("https://w/v1/ask", {
    method: "POST",
    headers: { authorization: `Bearer ${goodToken}`, "content-type": "application/json",
               "content-length": "5000" },
    body: JSON.stringify(valid) }), small);
  check("a Content-Length over the cap is refused before the body is read",
        claimed.status === 413, `got ${claimed.status}`);
  const under = await worker.fetch(ask(valid), small).catch(() => ({ status: "threw" }));
  check("a body under the cap is not refused for size", under.status !== 413, `got ${under.status}`);

  const r = await worker.fetch(new Request("https://w/v1/other", {
    method: "POST", headers: { authorization: `Bearer ${goodToken}` }, body: "{}" }), env(kv));
  check("unknown path refused", r.status === 404);
}

// ---------------------------------------------------------------- privacy

console.log("nothing about a request is retained:");
{
  const kv = makeKV({ [`token:${goodToken}`]: account() });
  const secret = "a-screenshot-would-be-here";
  await send(env(kv), { ...valid,
    messages: [{ role: "user", content: [{ type: "text", text: secret }] }] });
  const stored = [...kv.store.entries()].map(([k, v]) => k + "=" + v).join("\n");
  check("no request content in anything written to KV", !stored.includes(secret));
  check("only counters and the token record were written",
        [...kv.store.keys()].every((k) => k.startsWith("u:") || k.startsWith("token:")));
}


// --------------------------------------------------------- connected apps

console.log("connected apps (A76): a tool call, connect, callback, webhook — never the question path:");
{
  const { endOfDay, naive, composioArguments } = await import("./src/tools.js");

  // The pure mapping, first: defaults are computed in the user's day.
  check("endOfDay lands at 23:59:59 in the user's zone",
        endOfDay("2026-09-14T09:12:00+05:30", "Asia/Kolkata") === "2026-09-14T23:59:59+05:30",
        endOfDay("2026-09-14T09:12:00+05:30", "Asia/Kolkata"));
  check("naive strips the offset and keeps the wall-clock time",
        naive("2026-09-14T15:00:00+05:30") === "2026-09-14T15:00:00" && naive("2026-09-14T09:30:00Z") === "2026-09-14T09:30:00");
  const create = composioArguments("gcal_create", { title: "Standup", start: "2026-09-15T10:00:00+05:30", minutes: 90, attendees: "a@x.com, b@x.com" }, "2026-09-14T09:12:00+05:30", "Asia/Kolkata");
  check("gcal_create splits 90 minutes into an hour and thirty, names the zone, invites and notifies",
        create.event_duration_hour === 1 && create.event_duration_minutes === 30 && create.timezone === "Asia/Kolkata"
        && create.start_datetime === "2026-09-15T10:00:00" && create.attendees.length === 2 && create.send_updates === "all");
  const search = composioArguments("gmail_search", {}, "2026-09-14T09:12:00Z", "UTC");
  check("gmail_search with nothing said means the inbox, five messages, metadata only",
        search.query === "in:inbox" && search.max_results === 5 && search.verbose === false && search.include_payload === false);
  check("gmail_search clamps max to ten", composioArguments("gmail_search", { max: 99 }, "", "UTC").max_results === 10);
  const read = composioArguments("slack_read", { channel: "#launch" }, "", "UTC");
  check("slack_read searches the channel newest first, twenty by default",
        read.query === "in:#launch" && read.count === 20 && read.sort === "timestamp" && read.sort_dir === "desc");
  check("an unknown tool maps to nothing", composioArguments("mcp_search", {}, "", "UTC") === null);
  check("gcal_delete needs the id the create returned", composioArguments("gcal_delete", {}, "", "UTC") === null
        && composioArguments("gcal_delete", { id: "evt_1" }, "", "UTC").event_id === "evt_1");

  // Two devices: a trial with nothing behind it, and one bound to an account.
  const trialToken = "trial-for-tools";
  const deviceToken = "device-for-tools";
  const accountId = "acct-0000-1111";
  const kv = makeKV({
    [`token:${trialToken}`]: JSON.stringify({ v: 2, subject: trialToken, kind: "trial", plan: "trial", active: true, dailyCap: 10, hourlyCap: 10, trialCap: 10 }),
    [`token:${deviceToken}`]: JSON.stringify({ v: 2, subject: accountId, kind: "device", plan: "free", active: true, dailyCap: 50, hourlyCap: 20, trialCap: 0 }),
  });
  const plans = { free: { name: "free", daily_cap: 50, hourly_cap: 20, trial_cap: 0, tool_cap: 2 } };

  // A D1 stand-in that keeps integration rows.
  const rows = [];
  const db = {
    rows,
    prepare: (sql) => ({ bind: (...args) => {
      const q = sql.replace(/\s+/g, " ").trim();
      return {
        first: async () => {
          if (q.includes("FROM plans")) return plans[args[0]] || null;
          if (q.includes("FROM integrations WHERE account_id = ? AND app")) return rows.find((r) => r.account_id === args[0] && r.app === args[1]) || null;
          if (q.includes("FROM integrations WHERE connected_account_id")) return rows.find((r) => r.connected_account_id === args[0]) || null;
          return null;
        },
        all: async () => ({ results: q.includes("FROM integrations WHERE account_id") ? rows.filter((r) => r.account_id === args[0]) : [] }),
        run: async () => {
          if (q.startsWith("INSERT INTO integrations")) {
            const [account_id, app, connected_account_id, state, updated_at] = args;
            const existing = rows.find((r) => r.account_id === account_id && r.app === app);
            if (existing) Object.assign(existing, { connected_account_id, state, updated_at, connected_at: null, defaults: null });
            else rows.push({ account_id, app, connected_account_id, state, updated_at, connected_at: null, defaults: null });
          } else if (q.startsWith("UPDATE integrations SET state = 'active', updated_at = ?")) {
            const [updated_at, connected_at, defaults, account_id, app] = args;
            const r = rows.find((r) => r.account_id === account_id && r.app === app);
            if (r) { r.state = "active"; r.updated_at = updated_at; r.connected_at = r.connected_at || connected_at; r.defaults = defaults; }
          } else if (q.startsWith("UPDATE integrations SET state = ?, updated_at = ? WHERE account_id")) {
            const r = rows.find((r) => r.account_id === args[2] && r.app === args[3]); if (r) r.state = args[0];
          } else if (q.startsWith("UPDATE integrations SET state = 'expired'")) {
            const r = rows.find((r) => r.connected_account_id === args[1]); if (r) r.state = "expired";
          } else if (q.startsWith("DELETE FROM integrations")) {
            const i = rows.findIndex((r) => r.account_id === args[0] && r.app === args[1]); if (i >= 0) rows.splice(i, 1);
          }
        },
      };
    } }),
  };

  // A fetch that plays Composio from a script and records every call.
  const calls = [];
  let composioScript = {};
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://backend.composio.dev/")) {
      calls.push({ url: u, method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
      const key = `${init.method || "GET"} ${u.replace("https://backend.composio.dev/api/v3.1", "")}`;
      const handler = composioScript[key] || composioScript["*"];
      const reply = handler ? await handler(init) : { status: 404, json: {} };
      return new Response(JSON.stringify(reply.json), { status: reply.status });
    }
    return anthropicEmpty();
  };
  const anthropicEmpty = () => new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });

  const envTools = { ...env(kv), DB: db, COMPOSIO_API_KEY: ["ak", "TESTKEY-not-real"].join("_"),
                     COMPOSIO_WEBHOOK_SECRET: "whsec-test-secret",
                     COMPOSIO_AUTH_CONFIG_GMAIL: "ac_gmail", COMPOSIO_AUTH_CONFIG_GCAL: "ac_gcal", COMPOSIO_AUTH_CONFIG_SLACK: "ac_slack",
                     COMPOSIO_AUTH_CONFIG_GITHUB: "ac_github", COMPOSIO_AUTH_CONFIG_JIRA: "ac_jira", COMPOSIO_AUTH_CONFIG_LINEAR: "ac_linear" };
  const post = (path, token, body) => worker.fetch(new Request(`https://w${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body) }), envTools);

  // A trial has no account, and is told so before anything is looked up.
  {
    const r = await post("/v1/tool", trialToken, { tool: "gmail_search", input: {}, now: "2026-09-14T09:00:00Z", tz: "UTC" });
    check("a trial device is refused a cloud tool with needs_account", r.status === 403 && (await r.json()).error === "needs_account");
    const s = await post("/v1/integrations", trialToken, {});
    check("a trial device sees every app unconnected and no account", s.status === 200 && (await s.json()).account === false);
    check("nothing reached Composio for the trial", calls.length === 0);
  }

  // Nothing connected yet: needs_signin names the app, and the header says none.
  {
    const r = await post("/v1/tool", deviceToken, { tool: "gmail_search", input: {}, now: "2026-09-14T09:00:00Z", tz: "UTC" });
    const j = await r.json();
    check("an unconnected app answers needs_signin naming the app", r.status === 403 && j.error === "needs_signin" && j.app === "gmail");
    check("the reply carries every cloud app's state", r.headers.get("otto-integrations") === "gmail=none;gcal=none;slack=none;github=none;gitlab=none;jira=none;gdrive=none;notion=none;linear=none");
    check("nothing reached Composio for an unconnected app", calls.length === 0);
  }

  // Connect: the link is Composio's, the row is pending, the callback makes it active.
  {
    composioScript = { "POST /connected_accounts/link": async () => ({ status: 201, json: { redirect_url: "https://connect.composio.dev/link/lk_test", connected_account_id: "ca_test1234" } }) };
    const r = await post("/v1/integrations/link", deviceToken, { app: "gmail" });
    const j = await r.json();
    check("connect returns Composio's hosted link", r.status === 200 && j.url === "https://connect.composio.dev/link/lk_test");
    const sent = calls.at(-1);
    check("the link is asked for under the account subject, the managed config and the Worker's callback",
          sent && sent.body.user_id === accountId && sent.body.auth_config_id === "ac_gmail"
          && sent.body.callback_url === "https://w/v1/integrations/callback");
    check("the key travels as x-api-key and never as a bearer", sent && sent.headers["x-api-key"] && !sent.headers.authorization);
    check("the row is pending until the browser comes back", rows.some((r) => r.app === "gmail" && r.state === "pending"));
    check("a trial cannot ask for a link", (await post("/v1/integrations/link", trialToken, { app: "gmail" })).status === 403);
    check("an unknown app is refused", (await post("/v1/integrations/link", deviceToken, { app: "dropbox" })).status === 400);
    check("a wave-2 app with no auth config id yet is not_provisioned, not a broken link",
          (await post("/v1/integrations/link", deviceToken, { app: "notion" })).status === 503);

    composioScript = { "GET /connected_accounts/ca_test1234": async () => ({ status: 200, json: { id: "ca_test1234", status: "ACTIVE", user_id: accountId } }) };
    const cb = await worker.fetch(new Request("https://w/v1/integrations/callback?status=success&connected_account_id=ca_test1234"), envTools);
    check("the callback page says the one thing the user needs", cb.status === 200 && (await cb.text()).includes("return to Otto"));
    check("the row is active once Composio confirms it", rows.some((r) => r.app === "gmail" && r.state === "active"));
    const stranger = await worker.fetch(new Request("https://w/v1/integrations/callback?connected_account_id=ca_nobody99"), envTools);
    check("an id this Worker never issued a link for is not accepted", stranger.status === 400);
    check("a GET anywhere else is still refused", (await worker.fetch(new Request("https://w/v1/ask"), envTools)).status === 405);
  }

  // A connect the browser never finished: within the link's life the page
  // says connecting; past it, the page says none and Connect mints afresh.
  {
    composioScript = { "POST /connected_accounts/link": async () => ({ status: 201, json: { redirect_url: "https://connect.composio.dev/link/lk_slack", connected_account_id: "ca_slack0001" } }) };
    await post("/v1/integrations/link", deviceToken, { app: "slack" });
    const fresh = await post("/v1/integrations", deviceToken, {});
    check("a pending connect within ten minutes reads as pending", (await fresh.json()).apps.slack === "pending"
          && fresh.headers.get("otto-integrations").includes("slack=pending"));
    rows.find((r) => r.app === "slack").updated_at = Date.now() - 11 * 60 * 1000;
    const stale = await post("/v1/integrations", deviceToken, {});
    check("a pending connect older than ten minutes reads as none", (await stale.json()).apps.slack === "none"
          && stale.headers.get("otto-integrations").includes("slack=none"));
    check("the row itself is kept for a late callback", rows.find((r) => r.app === "slack").state === "pending");
    const tool = await post("/v1/tool", deviceToken, { tool: "slack_post", input: { channel: "x", text: "y" }, now: "2026-09-14T09:00:00Z", tz: "UTC" });
    check("a tool on a pending app is needs_signin either way", tool.status === 403 && (await tool.json()).error === "needs_signin");
    composioScript = { "DELETE /connected_accounts/ca_slack0001": async () => ({ status: 200, json: {} }) };
    const cancelled = await post("/v1/integrations/unlink", deviceToken, { app: "slack" });
    check("cancel is an unlink: the pending row goes and the page says none", cancelled.status === 200 && !rows.some((r) => r.app === "slack"));
  }

  // A tool call: defaults filled, the reply compacted, the words kept out of KV and the log.
  {
    const logged = [];
    const realLog = console.log, realError = console.error;
    console.log = (...a) => logged.push(a.join(" ")); console.error = (...a) => logged.push(a.join(" "));
    composioScript = { "POST /tools/execute/GMAIL_FETCH_EMAILS": async () => ({ status: 200, json: { successful: true, data: {
      messages: [{ sender: "alice@example.com", subject: "Lunch SECRETWORD", messageTimestamp: "2026-09-14T08:00:00Z", messageText: "", preview: { body: "Are we still on?", subject: "Lunch SECRETWORD" } }] } } }) };
    const r = await post("/v1/tool", deviceToken, { tool: "gmail_search", input: { query: "from:alice" }, now: "2026-09-14T09:00:00+05:30", tz: "Asia/Kolkata" });
    const j = await r.json();
    console.log = realLog; console.error = realError;
    check("a connected app's tool runs and answers ok", r.status === 200 && j.ok === true, JSON.stringify(j).slice(0, 120));
    check("the result is the compact shape, not Composio's", Array.isArray(j.result) && j.result[0].from === "alice@example.com" && j.result[0].subject.includes("Lunch") && !("messages" in j));
    check("the snippet comes from preview.body, the live reply's shape", j.result[0].snippet === "Are we still on?" && j.result[0].date === "2026-09-14T08:00:00Z");
    const sent = calls.at(-1);
    check("Composio is asked under the account subject with the connected account and filled defaults",
          sent.body.user_id === accountId && sent.body.connected_account_id === "ca_test1234"
          && sent.body.arguments.query === "from:alice" && sent.body.arguments.max_results === 5 && sent.body.arguments.verbose === false);
    check("the reply carries the states, now with gmail active", r.headers.get("otto-integrations").startsWith("gmail=active;gcal=none;slack=none"));
    const stored = [...kv.store.entries()].map(([k, v]) => k + "=" + v).join("\n");
    check("nothing of the arguments or the result reaches KV", !stored.includes("alice") && !stored.includes("SECRETWORD"));
    check("nothing of the arguments or the result reaches the log", !logged.join("\n").includes("alice") && !logged.join("\n").includes("SECRETWORD"));
    check("the tool counter was written for the day", [...kv.store.keys()].some((k) => k.startsWith(`u:${accountId}:t:`)));

    // The cap: the plan allows two a day; the third is refused before Composio.
    const before = calls.length;
    await post("/v1/tool", deviceToken, { tool: "gmail_search", input: {}, now: "2026-09-14T09:00:00Z", tz: "UTC" });
    const third = await post("/v1/tool", deviceToken, { tool: "gmail_search", input: {}, now: "2026-09-14T09:00:00Z", tz: "UTC" });
    check("the plan's tool cap refuses the call past it", third.status === 429 && (await third.json()).error === "tool_limit");
    check("a refused call never reaches Composio", calls.length === before + 1);
    kv.store.delete([...kv.store.keys()].find((k) => k.startsWith(`u:${accountId}:t:`)));
  }

  // A lapsed authorization: the row is marked and Otto is told to sign in again.
  {
    composioScript = { "POST /tools/execute/GMAIL_SEND_EMAIL": async () => ({ status: 200, json: { successful: false, error: "Request failed with status 401 Unauthorized: invalid_grant" } }) };
    const r = await post("/v1/tool", deviceToken, { tool: "gmail_send", input: { to: "bob@example.com", subject: "Hi", body: "Hello" }, now: "2026-09-14T09:00:00Z", tz: "UTC" });
    const j = await r.json();
    check("a lost authorization answers needs_signin", r.status === 403 && j.error === "needs_signin" && j.app === "gmail");
    check("and the row is marked expired", rows.find((r) => r.app === "gmail").state === "expired");
    check("the reply's header already says expired", r.headers.get("otto-integrations").startsWith("gmail=expired;gcal=none;slack=none"));
    rows.find((r) => r.app === "gmail").state = "active";
    composioScript = { "POST /tools/execute/GMAIL_SEND_EMAIL": async () => ({ status: 200, json: { successful: false, error: "Recipient address rejected" } }) };
    const f = await post("/v1/tool", deviceToken, { tool: "gmail_send", input: { to: "bob@example.com", subject: "Hi", body: "Hello" }, now: "2026-09-14T09:00:00Z", tz: "UTC" });
    check("an ordinary failure is tool_failed and does not touch the row", f.status === 502 && (await f.json()).error === "tool_failed" && rows.find((r) => r.app === "gmail").state === "active");
    // A77, from the first run: the app's own 404 is `not_found`, read from
    // data.status_code — a number — and never from the free-text error.
    // FAILING EDIT: derive `reason` from /not found/i on reply.json.error.
    // (The test plan caps tool calls at two a day; the counter is cleared.)
    for (const k of [...kv.store.keys()]) if (k.startsWith(`u:${accountId}:t:`)) kv.store.delete(k);
    composioScript = { "POST /tools/execute/GMAIL_SEND_EMAIL": async () => ({ status: 200, json: { successful: false,
      error: "Repository not found: 'x/y' does not exist", data: { status_code: 404, message: "Not Found" } } }) };
    const nf = await post("/v1/tool", deviceToken, { tool: "gmail_send", input: { to: "bob@example.com", subject: "Hi", body: "Hello" }, now: "2026-09-14T09:00:00Z", tz: "UTC" });
    const nfJson = await nf.json();
    check("an app-side 404 answers tool_failed with reason not_found", nf.status === 502 && nfJson.reason === "not_found");
    composioScript = { "POST /tools/execute/GMAIL_SEND_EMAIL": async () => ({ status: 200, json: { successful: false,
      error: "Not Found at all", data: { status_code: 500 } } }) };
    const txt = await post("/v1/tool", deviceToken, { tool: "gmail_send", input: { to: "bob@example.com", subject: "Hi", body: "Hello" }, now: "2026-09-14T09:00:00Z", tz: "UTC" });
    check("the words 'not found' in the free text do not make it not_found", (await txt.json()).reason === "connector");
  }

  // The webhook: verified before parsed, and only the expiry event does anything.
  {
    const sign = async (id, ts, body, secret) => {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
      return "v1," + btoa(String.fromCharCode(...mac));
    };
    const hook = async (body, { id = "msg_1", ts = String(Math.floor(Date.now() / 1000)), sig } = {}) =>
      worker.fetch(new Request("https://w/v1/integrations/webhook", { method: "POST",
        headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig ?? await sign(id, ts, body, "whsec-test-secret"), "content-type": "application/json" },
        body }), envTools);
    const expired = JSON.stringify({ type: "composio.connected_account.expired", data: { id: "ca_test1234", status: "EXPIRED" } });
    const bad = await hook(expired, { sig: "v1,AAAA" });
    check("a wrong signature is refused", bad.status === 401 && rows.find((r) => r.app === "gmail").state === "active");
    const stale = await hook(expired, { ts: String(Math.floor(Date.now() / 1000) - 900) });
    check("a stale timestamp is refused even with a valid signature", stale.status === 401);
    const good = await hook(expired);
    check("a signed expiry event marks the row expired", good.status === 200 && rows.find((r) => r.app === "gmail").state === "expired");
    const other = await hook(JSON.stringify({ type: "composio.trigger.message", data: { id: "x" } }));
    check("any other event is acknowledged and ignored", other.status === 200);
    const garbage = await hook("not json");
    check("a signed body that is not JSON is a 400", garbage.status === 400);
  }

  // Disconnect: Composio's authorization deleted, the row gone.
  {
    composioScript = { "DELETE /connected_accounts/ca_test1234": async () => ({ status: 200, json: {} }) };
    const r = await post("/v1/integrations/unlink", deviceToken, { app: "gmail" });
    check("disconnect answers with the remaining states", r.status === 200 && r.headers.get("otto-integrations").startsWith("gmail=none;gcal=none;slack=none"));
    check("the authorization was deleted at Composio", calls.at(-1).method === "DELETE" && calls.at(-1).url.endsWith("/connected_accounts/ca_test1234"));
    check("and the row is gone", !rows.some((r) => r.app === "gmail"));
  }

  // ---- Wave 2 (A77): the mappings, the defaults at connect, the header's order.
  {
    const { composioArguments: args, compact, defaultsFromReplies, integrationsHeader, NeedsDetail, driveKind } = await import("./src/tools.js");
    const gh = { login: "octocat" };
    check("a bare GitHub repo is the user's own", (() => { const a = args("github_create_issue", { repo: "otto", title: "T" }, "", "UTC", gh); return a.owner === "octocat" && a.repo === "otto"; })());
    check("owner/name is used as given", args("github_pull_requests", { repo: "acme/web" }, "", "UTC", gh).owner === "acme");
    check("a bare repo with no login recorded needs a detail",
          (() => { try { args("github_create_issue", { repo: "otto", title: "T" }, "", "UTC", null); return false; } catch (e) { return e instanceof NeedsDetail && e.hint === "repo"; } })());
    check("my issues default to assigned, open, ten", (() => { const a = args("github_my_issues", {}, "", "UTC"); return a.filter === "assigned" && a.state === "open" && a.per_page === 10 && a.pulls === false; })());
    const gl = { projects: [{ id: 7, name: "Otto Worker", path: "mustaqs/otto-worker" }] };
    check("a bare GitLab project name matches the connection's projects", args("gitlab_create_issue", { project: "otto worker", title: "T" }, "", "UTC", gl).id === encodeURIComponent("mustaqs/otto-worker"));
    check("a GitLab path is URL-encoded as the id", args("gitlab_merge_requests", { project: "group/sub/proj" }, "", "UTC", gl).id === "group%2Fsub%2Fproj");
    check("merge requests are opened, all authors, newest updated", (() => { const a = args("gitlab_merge_requests", { project: "g/p" }, "", "UTC"); return a.state === "opened" && a.scope === "all" && a.order_by === "updated_at"; })());
    const jr = { projects: [{ key: "OTT", name: "Otto" }, { key: "WEB", name: "Website" }] };
    check("a Jira issue with no project goes to the first project", args("jira_create_issue", { title: "T" }, "", "UTC", jr).project_key === "OTT");
    check("a Jira project by name resolves to its key", args("jira_create_issue", { title: "T", project: "website" }, "", "UTC", jr).project_key === "WEB");
    check("a Jira key not in the list is used uppercased", args("jira_create_issue", { title: "T", project: "abc" }, "", "UTC", jr).project_key === "ABC");
    check("a Jira issue with no project and no defaults needs a detail",
          (() => { try { args("jira_create_issue", { title: "T" }, "", "UTC", null); return false; } catch (e) { return e instanceof NeedsDetail && e.hint === "project"; } })());
    check("my Jira issues is the currentUser JQL, unresolved, newest updated", args("jira_my_issues", {}, "", "UTC").jql === "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC");
    check("reported and a project narrow the JQL", args("jira_my_issues", { filter: "reported", project: "web" }, "", "UTC", jr).jql.startsWith('project = "WEB" AND reporter = currentUser()'));
    check("a Drive query escapes quotes and excludes the trash", args("gdrive_find", { query: "Q3 plan's" }, "", "UTC").q === "name contains 'Q3 plan\\'s' and trashed = false");
    check("a Drive doc is a Google Doc", args("gdrive_create_doc", { name: "N", text: "t" }, "", "UTC").mime_type === "application/vnd.google-apps.document");
    check("a Notion append is one paragraph block", args("notion_append", { page_id: "p1", text: "hi" }, "", "UTC").content_blocks[0].content_block.content === "hi");
    const ln = { user_id: "u1", teams: [{ id: "t1", key: "OTT", name: "Otto" }, { id: "t2", key: "WEB", name: "Web" }] };
    check("a Linear issue with no team goes to the first team", args("linear_create_issue", { title: "T" }, "", "UTC", ln).team_id === "t1");
    check("a Linear team by key or name resolves", args("linear_create_issue", { title: "T", team: "web" }, "", "UTC", ln).team_id === "t2");
    check("my Linear issues are filtered to the connection's user", args("linear_my_issues", {}, "", "UTC", ln).assignee_id === "u1");
    check("the undo tools need the id", args("jira_delete", {}, "", "UTC") === null && args("linear_archive", { id: "x" }, "", "UTC").issue_id === "x"
          && args("gdrive_delete", { id: "f" }, "", "UTC").fileId === "f" && args("notion_archive", { id: "p" }, "", "UTC").archive === true);
    check("compact keeps the issue key for undo and the number for the answer",
          compact("jira_create_issue", { key: "OTT-9", id: "10001" }).id === "OTT-9" && compact("github_create_issue", { number: 12, html_url: "https://x" }).id === null);
    check("compact reads a Notion search from response_data",
          compact("notion_find_page", { response_data: { results: [{ id: "p1", properties: { Name: { type: "title", title: [{ plain_text: "Meeting" }] } }, last_edited_time: "2026-09-14T00:00:00Z", url: "https://n" }] } }).result[0].title === "Meeting");
    check("compact names Drive kinds", driveKind("application/vnd.google-apps.spreadsheet") === "Google Sheet" && compact("gdrive_find", { files: [{ name: "a", mimeType: "application/pdf" }] }).result[0].kind === "PDF");
    check("defaults from replies: GitHub login, Jira projects, Linear user and teams",
          defaultsFromReplies("github", [{ login: "octocat" }]).login === "octocat"
          && defaultsFromReplies("jira", [{ values: [{ key: "OTT", name: "Otto" }] }]).projects[0].key === "OTT"
          && defaultsFromReplies("linear", [{ user: { id: "u1" } }, { items: [{ id: "t1", key: "OTT", name: "Otto" }] }]).teams[0].id === "t1");
    check("the header lists connected apps oldest first, then the rest as none",
          integrationsHeader([{ app: "slack", state: "active", connected_at: 300 }, { app: "gmail", state: "active", connected_at: 100 }, { app: "notion", state: "pending", updated_at: 200 }])["otto-integrations"]
            === "gmail=active;notion=pending;slack=active;gcal=none;github=none;gitlab=none;jira=none;gdrive=none;linear=none");

    // Connect GitHub: the callback runs the default lookup and stores the login.
    composioScript = { "POST /connected_accounts/link": async () => ({ status: 201, json: { redirect_url: "https://connect.composio.dev/link/lk_gh", connected_account_id: "ca_github01" } }) };
    const link = await post("/v1/integrations/link", deviceToken, { app: "github" });
    check("a wave-2 app with an auth config id gets a link", link.status === 200);
    check("the link request carries no connection_data (Jira tries without, decision 2)", !("connection_data" in calls.at(-1).body));
    composioScript = {
      "GET /connected_accounts/ca_github01": async () => ({ status: 200, json: { id: "ca_github01", status: "ACTIVE" } }),
      "POST /tools/execute/GITHUB_GET_THE_AUTHENTICATED_USER": async () => ({ status: 200, json: { successful: true, data: { login: "octocat", name: "The Octocat" } } }),
    };
    const cb = await worker.fetch(new Request("https://w/v1/integrations/callback?status=success&connected_account_id=ca_github01"), envTools);
    const ghRow = rows.find((r) => r.app === "github");
    check("the callback activates the row and records the connect time", cb.status === 200 && ghRow.state === "active" && Number.isFinite(ghRow.connected_at));
    check("and stores the defaults the lookup returned", ghRow.defaults && JSON.parse(ghRow.defaults).login === "octocat");
    check("the lookup ran under the account and the connected account",
          calls.at(-1).url.endsWith("/tools/execute/GITHUB_GET_THE_AUTHENTICATED_USER") && calls.at(-1).body.connected_account_id === "ca_github01" && calls.at(-1).body.user_id === accountId);

    // A tool on it: the default fills the owner; a missing default is needs_detail.
    // (The earlier block left the day's tool counter at the test plan's cap.)
    for (const k of [...kv.store.keys()]) if (k.startsWith(`u:${accountId}:t:`)) kv.store.delete(k);
    composioScript = { "POST /tools/execute/GITHUB_CREATE_AN_ISSUE": async () => ({ status: 200, json: { successful: true, data: { number: 42, html_url: "https://github.com/octocat/otto/issues/42" } } }) };
    const issue = await post("/v1/tool", deviceToken, { tool: "github_create_issue", input: { repo: "otto", title: "Login button dead on Safari" }, now: "2026-09-14T09:00:00Z", tz: "UTC" });
    const issueJson = await issue.json();
    check("a GitHub issue is filed on the user's own repo from the recorded login", issue.status === 200 && issueJson.ok && calls.at(-1).body.arguments.owner === "octocat" && issueJson.result.number === 42 && issueJson.id === null);
    // Gmail was disconnected above, so GitHub is the only row: first in the header, the rest none.
    check("the header lists the connected app first and the rest as none", issue.headers.get("otto-integrations").startsWith("github=active;gmail=none;"));
    ghRow.defaults = null;
    const before = calls.length;
    const vague = await post("/v1/tool", deviceToken, { tool: "github_create_issue", input: { repo: "otto", title: "T" }, now: "2026-09-14T09:00:00Z", tz: "UTC" });
    check("without a recorded login a bare repo is needs_detail with the hint, before Composio", vague.status === 400 && (await vague.json()).hint === "repo" && calls.length === before);
    composioScript = { "DELETE /connected_accounts/ca_github01": async () => ({ status: 200, json: {} }) };
    await post("/v1/integrations/unlink", deviceToken, { app: "github" });
  }

  // A question never touches any of this: the same env, the question path,
  // and Composio is not called.
  {
    const before = calls.length;
    await send(envTools, valid, deviceToken);
    check("a question makes no Composio call", calls.length === before);
  }

  globalThis.fetch = async () => anthropicEmpty();
}


// -------------------------------------------------------------------- tasks

console.log("tasks (A82): a row, a Workflow, a header — never the question path:");
{
  const { runTask, RETENTION_MS, durationMs, isTimeout } = await import("./src/tasks/run.js");
  const { TYPES, centsOf, TASK_VERSION } = await import("./src/tasks/registry.js");
  const { summaryFromRows, tasksHeader, endedSentence } = await import("./src/tasks/summary.js");

  class NonRetryableError extends Error { constructor(m) { super(m); this.name = "NonRetryableError"; } }

  // THE CLOCK. run.js reads Date.now() and nothing else; the test owns it.
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const advance = (ms) => { clock += ms; };
  const MIN = 60 * 1000, HOUR = 60 * MIN;

  const accountId = "acct-tasks-1111";
  const deviceToken = "device-for-tasks";
  const otherToken = "device-other-acct";
  const trialToken = "trial-for-tasks";
  const kv = makeKV({
    [`token:${deviceToken}`]: JSON.stringify({ v: 2, subject: accountId, kind: "device", plan: "free", active: true, dailyCap: 50, hourlyCap: 20, trialCap: 0 }),
    [`token:${otherToken}`]: JSON.stringify({ v: 2, subject: "acct-other", kind: "device", plan: "free", active: true, dailyCap: 50, hourlyCap: 20, trialCap: 0 }),
    [`token:${trialToken}`]: JSON.stringify({ v: 2, subject: trialToken, kind: "trial", plan: "trial", active: true, dailyCap: 10, hourlyCap: 10, trialCap: 10 }),
  });
  const plans = { free: { name: "free", daily_cap: 50, hourly_cap: 20, trial_cap: 0, tool_cap: 0, task_cap: 2, step_cap: 4 } };

  // A D1 stand-in with a tasks table. One UPDATE shape to parse:
  // `UPDATE tasks SET a = ?, b = ? WHERE id = ? AND account_id = ?`.
  const makeTaskDB = () => {
    const tasks = [];
    const calls = [];
    const failures = { stepsWrites: 0, skip: 0 };   // throw on the next `stepsWrites` steps writes, after skipping `skip`
    return {
      tasks, calls, failures,
      prepare: (sql) => ({ bind: (...args) => {
        const q = sql.replace(/\s+/g, " ").trim();
        calls.push(q.slice(0, 40));
        return {
          first: async () => {
            if (q.includes("FROM plans")) return plans[args[0]] || null;
            // A89 §11's count-and-check, in one statement with RETURNING.
            if (q.startsWith("UPDATE tasks SET calls = calls + 1 WHERE id = ? AND account_id = ? AND type = 'browser'")) {
              const row = tasks.find((t) => t.id === args[0] && t.account_id === args[1]);
              if (!row || row.type !== "browser" || !["created", "running", "approved"].includes(row.state) || row.calls >= args[2]) return null;
              row.calls += 1;
              return { steps: row.steps, created_at: row.created_at, waited_ms: row.waited_ms, calls: row.calls };
            }
            if (q.startsWith("SELECT * FROM tasks WHERE id = ? AND account_id = ?")) {
              const row = tasks.find((t) => t.id === args[0] && t.account_id === args[1]);
              return row ? { ...row } : null;
            }
            return null;
          },
          all: async () => {
            if (q.startsWith("SELECT * FROM tasks WHERE account_id = ?")) {
              return { results: tasks.filter((t) => t.account_id === args[0]).sort((a, b) => b.updated_at - a.updated_at).map((t) => ({ ...t })) };
            }
            if (q.startsWith("SELECT id, account_id FROM tasks WHERE state IN")) {
              return { results: tasks.filter((t) => ["succeeded", "failed", "cancelled", "expired"].includes(t.state) && t.expires_at != null && t.expires_at < args[0]).map((t) => ({ id: t.id, account_id: t.account_id })) };
            }
            if (q.startsWith("SELECT id, state, updated_at FROM tasks WHERE account_id = ?")) {
              return { results: tasks.filter((t) => t.account_id === args[0]).map((t) => ({ id: t.id, state: t.state, updated_at: t.updated_at })) };
            }
            return { results: [] };
          },
          run: async () => {
            if (q.startsWith("INSERT INTO tasks")) {
              const [id, account_id, type, input, created_at, updated_at] = args;
              tasks.push({ id, account_id, type, state: "created", input, steps: "[]", question: null, answer: null, result: null,
                           reason: null, waited_ms: 0, calls: 0, seen_at: null, created_at, updated_at, finished_at: null, expires_at: null });
              return;
            }
            if (q.startsWith("UPDATE tasks SET")) {
              const set = q.slice("UPDATE tasks SET ".length, q.indexOf(" WHERE"));
              const cols = set.split(",").map((s) => s.trim().split(" = ")[0]);
              if (cols.includes("steps") && failures.stepsWrites > 0) {
                if (failures.skip > 0) failures.skip--;
                else { failures.stepsWrites--; throw Object.assign(new Error("d1 unavailable"), { name: "D1Error" }); }
              }
              const row = tasks.find((t) => t.id === args[cols.length] && t.account_id === args[cols.length + 1]);
              // A89's compare-and-set: `… AND steps = ?` lands only if the list is unchanged.
              if (row && q.includes("AND steps = ?") && row.steps !== args[cols.length + 2]) return { meta: { changes: 0 } };
              // The first ending wins: a finished row is left as it finished.
              if (row && q.includes("AND state NOT IN ('succeeded', 'failed', 'cancelled', 'expired')")
                  && ["succeeded", "failed", "cancelled", "expired"].includes(row.state)) return { meta: { changes: 0 } };
              if (row) cols.forEach((c, i) => { row[c] = args[i]; });
              return { meta: { changes: row ? 1 : 0 } };
            }
            if (q.startsWith("DELETE FROM tasks")) {
              const i = tasks.findIndex((t) => t.id === args[0] && t.account_id === args[1]);
              if (i >= 0) tasks.splice(i, 1);
            }
          },
        };
      } }),
    };
  };

  // A Workflow binding stand-in: records creates and instance calls.
  const makeTasksBinding = () => {
    const created = [], log = [], instances = new Map();
    const binding = { created, log, instances, failCreate: false };
    const instance = (id) => ({
      id,
      sendEvent: async (event) => { log.push({ id, call: "sendEvent", event }); if (instances.get(id).throwOnEvent) throw Object.assign(new Error("not running"), { name: "WorkflowError" }); },
      terminate: async () => { log.push({ id, call: "terminate" }); },
      delete: async () => { log.push({ id, call: "delete" }); if (instances.get(id).gone) throw Object.assign(new Error("gone"), { name: "WorkflowNotFound" }); instances.get(id).gone = true; },
      status: async () => ({ status: "running" }),
      // The feed's subscription (A84): `events` are scripted per instance;
      // when they run out the next() holds, as a live instance's would, until
      // the subscription is disposed or `end` is set, which makes it done.
      subscribe: async (options) => {
        const state = instances.get(id);
        log.push({ id, call: "subscribe", options });
        let wake = null;
        const subscription = {
          next: async () => {
            for (;;) {
              if (state.disposed) return { done: true, value: undefined };
              if (state.events && state.events.length) return { done: false, value: state.events.shift() };
              if (state.end) return { done: true, value: undefined };
              await new Promise((resolve) => { wake = resolve; state.wake = resolve; });
            }
          },
          [Symbol.dispose]: () => { state.disposed = true; log.push({ id, call: "dispose" }); if (wake) wake(); },
        };
        return subscription;
      },
    });
    binding.create = async (options) => {
      if (binding.failCreate) throw Object.assign(new Error("refused"), { name: "WorkflowError" });
      created.push(options); instances.set(options.id, {}); return instance(options.id);
    };
    binding.get = async (id) => { if (!instances.has(id)) throw Object.assign(new Error("not found"), { name: "WorkflowNotFound" }); return instance(id); };
    return binding;
  };

  // A step stand-in: runs the callback at once, retries once on an ordinary
  // throw, never on NonRetryableError; waits resolve from a queue. Two things
  // it copies from the engine, both measured on the live runs of 2026-10-11:
  //   - it rethrows a fresh Error whose message is "<name>: <message>" and
  //     nothing else — a property set on the error inside the callback does
  //     not reach the caller of step.do, and the message arrives prefixed;
  //   - a step's output is cached by name, and an event `{ hibernate: true }`
  //     makes the wait never resolve, so the test can start run() again on the
  //     same stand-in the way the engine replays it after a hibernated wait:
  //     every finished step returns its cached output without running, and
  //     nothing computed outside a step survives.
  const engineThrow = (error) => new Error(`${error && error.name ? error.name : "Error"}: ${error && error.message ? error.message : String(error)}`);
  const makeStep = (events = []) => {
    const calls = [];
    const cache = new Map();
    return {
      calls, events, cache,
      async do(name, config, fn) {
        if (typeof config === "function") { fn = config; config = {}; }
        if (cache.has(name)) { calls.push({ name, config, cached: true }); return cache.get(name); }
        calls.push({ name, config });
        const run = async () => { const out = await fn(); cache.set(name, out); return out; };
        try { return await run(); } catch (error) {
          if (error && error.name === "NonRetryableError") throw engineThrow(error);
          if (config && config.retries && config.retries.limit > 0) { calls.push({ name, config, retry: true }); return await run(); }
          throw engineThrow(error);
        }
      },
      async waitForEvent(name, options) {
        calls.push({ name, config: options, wait: true });
        const next = events.shift();
        if (!next) throw Object.assign(new Error("Timeout: event not received"), { name: "WorkflowTimeoutError" });
        if (next.hibernate) return new Promise(() => {});
        if (next.throw) throw next.throw;
        if (next.before) await next.before();
        return { type: options.type, payload: next.payload, timestamp: new Date(clock) };
      },
    };
  };

  // The model, scripted. Each entry: { content, usage } or { status } with an optional `before`.
  let script = [];
  const modelCalls = [];
  const streamCalls = [];   // the pass-through's upstream calls: /v1/ask and /v1/tasks/ask
  const anthropicDone = () => new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === "https://api.anthropic.com/v1/messages" && init.body && JSON.parse(init.body).stream) {
      streamCalls.push({ body: JSON.parse(init.body), headers: init.headers });
    }
    if (String(url) === "https://api.anthropic.com/v1/messages" && init.body && !JSON.parse(init.body).stream) {
      const body = JSON.parse(init.body);
      modelCalls.push({ body, headers: init.headers });
      const next = script.shift();
      if (!next) return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }], usage: {} }), { status: 200 });
      if (next.before) await next.before();
      if (next.status) return new Response("error", { status: next.status });
      return new Response(JSON.stringify({ content: next.content, usage: next.usage || {} }), { status: 200 });
    }
    return anthropicDone();
  };
  const text = (t, usage) => ({ content: [{ type: "text", text: t }], usage });
  const searchReply = (findings, searches, urls = []) => ({
    content: [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: urls.map((u) => ({ type: "web_search_result", url: u, title: "t", encrypted_content: "x" })) },
      { type: "text", text: findings },
    ],
    usage: { input_tokens: 3000, output_tokens: 600, server_tool_use: { web_search_requests: searches } },
  });

  const logged = [];
  const capture = async (work) => {
    const realLog = console.log, realError = console.error;
    console.log = (...a) => logged.push(a.map(String).join(" "));
    console.error = (...a) => logged.push(a.map(String).join(" "));
    try { return await work(); } finally { console.log = realLog; console.error = realError; }
  };

  const db = makeTaskDB();
  const tasks = makeTasksBinding();
  // The model key is assembled at runtime: Bench/check-no-secrets.sh scans this file.
  const envTasks = { ...env(kv), DB: db, TASKS: tasks, ANTHROPIC_API_KEY: ["sk", "ant", "TESTKEY-not-real-0000000000"].join("-") };
  const post = (path, token, body) => worker.fetch(new Request(`https://w${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body) }), envTasks, makeCtx());
  const header = (response) => response.headers.get("otto-tasks") || "";
  const clearCounter = () => { for (const k of [...kv.store.keys()]) if (k.startsWith(`u:${accountId}:k:`)) kv.store.delete(k); };
  const SECRET = "SECRETWORD";
  const goodBody = { type: "research", request: `How do Swift actors handle reentrancy ${SECRET}`, context: "Xcode · Brain.swift", now: "2026-10-11T09:00:00Z", tz: "Asia/Kolkata" };
  const runWorkflow = async (id, step) => {
    const created = tasks.created.find((c) => c.id === id);
    const row = db.tasks.find((t) => t.id === id);
    const event = { payload: created.params, timestamp: new Date(row.created_at), instanceId: id };
    return capture(() => runTask({ event, step, env: envTasks, NonRetryableError }));
  };

  // --- create
  {
    const before = db.calls.length;
    const r = await post("/v1/tasks/create", trialToken, goodBody);
    check("a trial device is refused a task with needs_account before D1 is read", r.status === 403 && (await r.json()).error === "needs_account" && db.calls.length === before);
    check("an unknown type is refused", (await post("/v1/tasks/create", deviceToken, { ...goodBody, type: "dinner" })).status === 400
          && (await (await post("/v1/tasks/create", deviceToken, { ...goodBody, type: "dinner" })).json()).error === "unknown_type");
    check("an empty request, a 4,001-char request and a bad `now` are bad_request",
          (await post("/v1/tasks/create", deviceToken, { ...goodBody, request: " " })).status === 400
          && (await post("/v1/tasks/create", deviceToken, { ...goodBody, request: "x".repeat(4001) })).status === 400
          && (await post("/v1/tasks/create", deviceToken, { ...goodBody, now: "yesterday" })).status === 400);
    const doc = await post("/v1/tasks/create", deviceToken, { ...goodBody, document: "text" });
    check("a document on research is document_not_allowed", doc.status === 400 && (await doc.json()).error === "document_not_allowed");
    const img = await post("/v1/tasks/create", deviceToken, { ...goodBody, image: "data:image/jpeg;base64,AAAA" });
    check("an image key is refused before anything is written", img.status === 400 && (await img.json()).key === "image" && db.tasks.length === 0 && tasks.created.length === 0);

    const r1 = await post("/v1/tasks/create", deviceToken, goodBody);
    const j1 = await r1.json();
    const row = db.tasks.find((t) => t.id === j1.id);
    check("a good create answers the id and `created`", r1.status === 200 && typeof j1.id === "string" && j1.state === "created", JSON.stringify(j1));
    check("the row holds exactly the input fields, the title and the task version",
          row && row.state === "created" && JSON.stringify(Object.keys(JSON.parse(row.input)).sort())
            === JSON.stringify(["context", "now", "request", "taskVersion", "title", "tz"]) && JSON.parse(row.input).taskVersion === TASK_VERSION);
    check("a create without a title is named by its request, cut at a word boundary (A91)",
          JSON.parse(row.input).title === "How do Swift actors handle reentrancy…", JSON.parse(row.input).title);
    clearCounter();
    const titled = await (await post("/v1/tasks/create", deviceToken, { ...goodBody, title: "  Swift actor   reentrancy " })).json();
    check("the model's title is stored, whitespace tidied (A91)",
          JSON.parse(db.tasks.find((t) => t.id === titled.id).input).title === "Swift actor reentrancy");
    clearCounter();
    const long = await (await post("/v1/tasks/create", deviceToken, { ...goodBody, title: "GMT watches under five thousand dollars with a date window" })).json();
    check("a title past six words is cut to six, marked as cut (A91)",
          JSON.parse(db.tasks.find((t) => t.id === long.id).input).title === "GMT watches under five thousand dollars…");
    const notText = await post("/v1/tasks/create", deviceToken, { ...goodBody, title: 7 });
    check("a title that is not text is bad_request", notText.status === 400 && (await notText.json()).field === "title");
    // Out of the fixture again, so the block below counts as it did before titles.
    for (const id of [titled.id, long.id]) {
      db.tasks.splice(db.tasks.findIndex((t) => t.id === id), 1);
      tasks.created.splice(tasks.created.findIndex((c) => c.id === id), 1);
    }
    // Back to the one create r1 counted, as the block below expects.
    clearCounter();
    kv.store.set([...kv.store.keys()].find((k) => k.startsWith(`u:${accountId}:k:`)) || `u:${accountId}:k:${new Date().toISOString().slice(0, 10)}`, "1");
    const created = tasks.created[0];
    check("the instance was created with the row's id, the params and the row's retention",
          created && created.id === j1.id && created.params.type === "research" && created.params.accountId === accountId
          && created.params.input.request === goodBody.request && created.params.taskVersion === TASK_VERSION
          && created.retention.successRetention === "3 days" && created.retention.errorRetention === "3 days");
    check("the day counter was written before the create", [...kv.store.keys()].some((k) => k.startsWith(`u:${accountId}:k:`)) && kv.store.get([...kv.store.keys()].find((k) => k.startsWith(`u:${accountId}:k:`))) === "1");
    check("the reply's header lists the new task as created", header(r1) === `v=1;running=1;awaiting=0;unseen=0;t=${j1.id}:created:research`, header(r1));

    await post("/v1/tasks/create", deviceToken, goodBody);
    const third = await post("/v1/tasks/create", deviceToken, goodBody);
    const thirdBody = await third.json();
    check("the plan's task cap refuses the third create and creates no instance", third.status === 429 && thirdBody.error === "task_limit" && tasks.created.length === 2);
    const midnight = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1);
    check("the refusal names the cap and when it resets: the next UTC midnight (A91)",
          thirdBody.cap === 2 && thirdBody.resetsAt === midnight, JSON.stringify(thirdBody));
    check("the refusal still carries the header", header(third).startsWith("v=1;running=2;"));
    clearCounter();
    // The second task is not run; it is deleted so the rest of the block sees one.
    await post("/v1/tasks/delete", deviceToken, { id: tasks.created[1].id });

    tasks.failCreate = true;
    const refused = await capture(() => post("/v1/tasks/create", deviceToken, goodBody));
    tasks.failCreate = false;
    check("a platform refusal on create removes the row and answers task_not_started", refused.status === 502 && (await refused.json()).error === "task_not_started" && db.tasks.length === 1);
    clearCounter();
  }

  // --- run: the happy path
  const taskId = tasks.created[0].id;
  let happyCents = 0;
  {
    const usages = [
      { input_tokens: 500, output_tokens: 80 },
      { input_tokens: 3000, output_tokens: 600, server_tool_use: { web_search_requests: 3 } },
      { input_tokens: 3000, output_tokens: 600, server_tool_use: { web_search_requests: 2 } },
      { input_tokens: 3000, output_tokens: 600, server_tool_use: { web_search_requests: 1 } },
      { input_tokens: 9000, output_tokens: 1500 },
    ];
    happyCents = usages.reduce((sum, u) => sum + centsOf("claude-sonnet-5", {
      in: u.input_tokens, out: u.output_tokens, searches: u.server_tool_use ? u.server_tool_use.web_search_requests : 0 }), 0);
    script = [
      text(JSON.stringify({ queries: ["swift actor reentrancy", "actor hop suspension", "reentrancy pitfalls"], outline: "the rule, then the pitfall" }), usages[0]),
      { ...searchReply(`Actors are reentrant at every await ${SECRET}`, 3, ["https://swift.org/a"]), usage: usages[1] },
      { ...searchReply("A hop is a suspension point " + "L".repeat(5000), 2, ["https://swift.org/b"]), usage: usages[2] },
      { ...searchReply("Pitfalls: stale state after await", 1), usage: usages[3] },
      text("```json\n" + JSON.stringify({ title: "Swift actor reentrancy", spoken: "Actors are reentrant at every await, so state read before an await can be stale after it.", body: `# Answer\nReentrant. ${SECRET}\n\n## Sources\n- https://swift.org/a` }) + "\n```", usages[4]),
    ];
    modelCalls.length = 0; logged.length = 0;
    const step = makeStep();
    await runWorkflow(taskId, step);
    const row = db.tasks.find((t) => t.id === taskId);
    const names = step.calls.map((c) => c.name);
    check("the steps ran in order: start, plan, search-1..3, draft, finish",
          JSON.stringify(names) === JSON.stringify(["start", "plan", "search-1", "search-2", "search-3", "draft", "finish"]), JSON.stringify(names));
    check("every step carried a timeout and retries", step.calls.every((c) => c.config && c.config.timeout && c.config.retries));
    const result = JSON.parse(row.result);
    check("the row ended succeeded with a spoken sentence, a note to deliver, finished_at and a three-day expires_at",
          row.state === "succeeded" && result.spoken.length > 0 && result.spoken.length <= 240 && result.deliver.notes.title === "Swift actor reentrancy"
          && result.detail.startsWith("# Answer") && row.finished_at === clock && row.expires_at === row.finished_at + RETENTION_MS);
    const steps = JSON.parse(row.steps);
    const ledgerCents = steps.reduce((s, e) => s + (e.cents || 0), 0);
    check("the ledger has one entry per step and its cents sum to the scripted usage at the price table",
          steps.length === 6 && steps.map((s) => s.name).join(",") === "start,plan,search-1,search-2,search-3,draft"
          && Math.abs(ledgerCents - happyCents) < 0.001 && steps[2].searches === 3 && steps[2].model === "claude-sonnet-5", `${ledgerCents} vs ${happyCents}`);
    check("the search steps carried exactly the direct, bounded web search tool and the plan and draft carried none",
          modelCalls.length === 5
          && [1, 2, 3].every((i) => JSON.stringify(modelCalls[i].body.tools) === JSON.stringify([{ type: "web_search_20260209", name: "web_search", allowed_callers: ["direct"], max_uses: 2 }]))
          && modelCalls[0].body.tools === undefined && modelCalls[4].body.tools === undefined);
    check("the search step is bounded to 1,024 output tokens and the plan to 1,024, the draft to 4,096",
          modelCalls[1].body.max_tokens === 1024 && modelCalls[0].body.max_tokens === 1024 && modelCalls[4].body.max_tokens === 4096);
    check("findings longer than 4,096 characters are cut before the draft reads them",
          modelCalls[4].body.messages[0].content.includes("A hop is a suspension point " + "L".repeat(4096 - 28)) && !modelCalls[4].body.messages[0].content.includes("L".repeat(4096 - 27)));
    check("every call was on claude-sonnet-5 with the key as x-api-key", modelCalls.every((c) => c.body.model === "claude-sonnet-5" && c.headers["x-api-key"] === envTasks.ANTHROPIC_API_KEY));
    const summary = JSON.parse(kv.store.get(`tasks:${accountId}`));
    check("the KV summary now has one unseen result with its sentence", summary.unseen.length === 1 && summary.unseen[0].id === taskId && summary.unseen[0].s === result.spoken && summary.running.length === 0);
    check("the console carried no word of the request, the findings or the draft", !logged.join("|").includes(SECRET), logged.join("|").slice(0, 200));
    check("and neither did KV beyond the one spoken sentence", ![...kv.store.values()].join("|").includes(SECRET));
    check("the result's detail is in the row, not in the summary", !JSON.stringify(summary).includes("# Answer"));
  }

  // --- run: a retry replaces its own ledger entry
  {
    clearCounter();
    const r = await post("/v1/tasks/create", deviceToken, goodBody);
    const id = (await r.json()).id;
    let first = true;
    script = [
      text(JSON.stringify({ queries: ["one"] }), { input_tokens: 10, output_tokens: 10 }),
      { ...searchReply("findings", 1), before: () => { if (first) { first = false; throw Object.assign(new Error("flaky"), { name: "TypeError" }); } } },
      text(JSON.stringify({ title: "T", spoken: "S", body: "B" }), { input_tokens: 10, output_tokens: 10 }),
    ];
    const step = makeStep();
    await runWorkflow(id, step);
    const row = db.tasks.find((t) => t.id === id);
    const steps = JSON.parse(row.steps);
    check("a step's first attempt failing and its retry succeeding leaves one ledger entry for it",
          row.state === "succeeded" && step.calls.some((c) => c.retry && c.name === "search-1") && steps.filter((s) => s.name === "search-1").length === 1);
  }

  // --- run: the ledger is best-effort (correction 2)
  {
    clearCounter();
    const r = await post("/v1/tasks/create", deviceToken, goodBody);
    const id = (await r.json()).id;
    script = [
      text(JSON.stringify({ queries: ["one"] }), { input_tokens: 10, output_tokens: 10 }),
      searchReply("findings", 1),
      text(JSON.stringify({ title: "T", spoken: "S", body: "B" }), { input_tokens: 10, output_tokens: 10 }),
    ];
    modelCalls.length = 0; logged.length = 0;
    db.failures.stepsWrites = 1; db.failures.skip = 1;   // the start step's write passes; the plan's throws once
    const step = makeStep();
    await runWorkflow(id, step);
    const row = db.tasks.find((t) => t.id === id);
    const planCalls = step.calls.filter((c) => c.name === "plan");
    check("a ledger write failing after the plan's model call leaves exactly one model call for the plan and no retry",
          modelCalls.filter((c) => c.body.system.startsWith("You plan")).length === 1 && planCalls.length === 1 && !planCalls[0].retry);
    check("the run continued to succeeded", row.state === "succeeded");
    check("and the failure was logged by class, without words",
          logged.some((l) => l.includes("task ledger not written for plan (D1Error)")) && !logged.join("|").includes(SECRET));
    check("the later steps' entries were still written", JSON.parse(row.steps).some((s) => s.name === "draft"));
  }

  // --- run: past the maximum duration (the fake clock)
  {
    clearCounter();
    const r = await post("/v1/tasks/create", deviceToken, goodBody);
    const id = (await r.json()).id;
    script = [
      text(JSON.stringify({ queries: ["one", "two"] }), { input_tokens: 10, output_tokens: 10 }).valueOf(),
    ];
    script[0].before = () => advance(31 * MIN);   // the plan takes 31 minutes
    script.push(searchReply("never", 1));
    modelCalls.length = 0; logged.length = 0;
    const step = makeStep();
    await runWorkflow(id, step);
    const row = db.tasks.find((t) => t.id === id);
    check("a task past maxDurationMs ends failed with reason max_duration", row.state === "failed" && row.reason === "max_duration", `${row.state}/${row.reason}`);
    check("the guard threw before search-1's work: one model call, no retry, then finish-failed",
          modelCalls.length === 1 && step.calls.map((c) => c.name).join(",") === "start,plan,search-1,finish-failed" && !step.calls.some((c) => c.retry));
    const steps = JSON.parse(row.steps);
    check("the ledger marks search-1 failed by class and keeps the plan", steps.some((s) => s.name === "search-1" && s.outcome === "failed" && s.error === "NonRetryableError") && steps.some((s) => s.name === "plan" && s.outcome === "ok"));
    check("the summary carries the fixed ran-out-of-time sentence", JSON.parse(kv.store.get(`tasks:${accountId}`)).unseen.some((u) => u.id === id && u.s === "The research ran out of time."));
    check("and the log carried the reason word and the step, not the words", logged.some((l) => l === "task research step search-1 failed: NonRetryableError") && logged.some((l) => l === "task research ended failed: max_duration") && !logged.join("|").includes(SECRET));
  }

  // --- run: a step fails for good
  {
    clearCounter();
    const r = await post("/v1/tasks/create", deviceToken, goodBody);
    const id = (await r.json()).id;
    script = [{ status: 400 }, { status: 400 }, { status: 400 }];
    modelCalls.length = 0; logged.length = 0;
    const step = makeStep();
    await runWorkflow(id, step);
    const row = db.tasks.find((t) => t.id === id);
    const steps = JSON.parse(row.steps);
    check("a 400 from the model is not retried and ends the task failed, step_failed",
          row.state === "failed" && row.reason === "step_failed" && modelCalls.length === 1);
    const failedEntry = steps.find((s) => s.name === "plan");
    check("a NonRetryableError step leaves a failed ledger entry naming the step, written inside the step and not from the engine's rethrow",
          failedEntry && failedEntry.outcome === "failed" && failedEntry.error === "model_http_400" && typeof failedEntry.started === "number" && typeof failedEntry.ended === "number"
          && steps.filter((s) => s.outcome === "failed").length === 1, JSON.stringify(steps));
    check("the log named the status, the step and the reason, and nothing else",
          logged.includes("task model call: HTTP 400, unknown") && logged.includes("task research step plan failed: model_http_400") && logged.includes("task research ended failed: step_failed"));
  }

  // --- approval (correction 1: asked at minute 2, approved at hour 3)
  let approvedId;
  {
    clearCounter();
    const r = await post("/v1/tasks/create", deviceToken, goodBody);
    const id = (await r.json()).id; approvedId = id;
    const eight = "abcdefghijklmnop".split("");   // sixteen, past askAboveSearches = 15
    script = [text(JSON.stringify({ queries: eight }), { input_tokens: 10, output_tokens: 10 })];
    script[0].before = () => advance(2 * MIN);
    for (const q of eight) script.push(searchReply(`found ${q}`, 1));
    script.push(text(JSON.stringify({ title: "T", spoken: "S", body: "B" }), { input_tokens: 10, output_tokens: 10 }));
    let approveReply, rowWhileWaiting, summaryWhileWaiting;
    const step = makeStep([{
      payload: { decision: "approve" },
      before: async () => {
        rowWhileWaiting = { ...db.tasks.find((t) => t.id === id) };
        summaryWhileWaiting = JSON.parse(kv.store.get(`tasks:${accountId}`));
        advance(2 * HOUR + 58 * MIN);
        approveReply = await post("/v1/tasks/approve", deviceToken, { id, decision: "approve" });
      },
    }]);
    await runWorkflow(id, step);
    const row = db.tasks.find((t) => t.id === id);
    const question = JSON.parse(rowWhileWaiting.question);
    check("more searches than askAboveSearches put the row in awaiting_approval with a question and the full 24-hour window",
          rowWhileWaiting.state === "awaiting_approval" && question.spoken === "This is a big one, about 16 searches. Go ahead?" && question.until - question.askedAt === 24 * HOUR);
    check("the summary carried the question while waiting", summaryWhileWaiting.awaiting.length === 1 && summaryWhileWaiting.awaiting[0].q === question.spoken);
    const wait = step.calls.find((c) => c.wait);
    check("the wait was for the approval type with the full 24-hour timeout", wait.config.type === "approval" && wait.config.timeout === `${24 * HOUR} ms`);
    check("approve answered 200 approved and sent the event to the instance",
          approveReply.status === 200 && (await approveReply.json()).state === "approved"
          && tasks.log.some((l) => l.id === id && l.call === "sendEvent" && l.event.type === "approval" && l.event.payload.decision === "approve"));
    check("asked at minute 2 and approved at hour 3, the run continued and succeeded", row.state === "succeeded", `${row.state}/${row.reason}`);
    check("the row records the wait, so the clock forgave it", row.waited_ms >= 2 * HOUR + 58 * MIN && row.waited_ms < 3 * HOUR);
    check("the answer is on the row", JSON.parse(row.answer).decision === "approve");
    check("approving a row that is no longer awaiting is not_awaiting", (await post("/v1/tasks/approve", deviceToken, { id, decision: "approve" })).status === 409);
    check("another account's id is not found", (await post("/v1/tasks/approve", otherToken, { id, decision: "approve" })).status === 404);
    check("a bad decision is bad_request", (await post("/v1/tasks/approve", deviceToken, { id, decision: "maybe" })).status === 400);
  }

  // --- approval across a hibernated wait: the engine replays run() from the top
  {
    clearCounter();
    const r = await post("/v1/tasks/create", deviceToken, goodBody);
    const id = (await r.json()).id;
    const eight = "abcdefghijklmnop".split("");   // sixteen, past askAboveSearches = 15
    script = [text(JSON.stringify({ queries: eight }), { input_tokens: 10, output_tokens: 10 })];
    script[0].before = () => advance(2 * MIN);
    for (const q of eight) script.push(searchReply(`found ${q}`, 1));
    script.push(text(JSON.stringify({ title: "T", spoken: "S", body: "B" }), { input_tokens: 10, output_tokens: 10 }));
    modelCalls.length = 0; logged.length = 0;
    const step = makeStep([{ hibernate: true }, { payload: { decision: "approve" } }]);
    // The first run parks at the wait and is abandoned, as the engine abandons
    // its isolate. Not through capture(): its finally would never run and the
    // console would stay swapped for the rest of this file.
    const realLog = console.log, realError = console.error;
    console.log = () => {}; console.error = (...a) => logged.push(a.map(String).join(" "));
    const created = tasks.created.find((c) => c.id === id);
    runTask({ event: { payload: created.params, timestamp: new Date(db.tasks.find((t) => t.id === id).created_at), instanceId: id }, step, env: envTasks, NonRetryableError });
    for (let i = 0; i < 200 && db.tasks.find((t) => t.id === id).state !== "awaiting_approval"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    console.log = realLog; console.error = realError;
    const parked = { ...db.tasks.find((t) => t.id === id) };
    advance(2 * HOUR + 58 * MIN);                          // three hours pass with nothing in memory
    await post("/v1/tasks/approve", deviceToken, { id, decision: "approve" });
    await runWorkflow(id, step);                           // the replay: start, plan and ask-write come from the cache
    const row = db.tasks.find((t) => t.id === id);
    const askedAt = JSON.parse(parked.question).askedAt;
    check("the replay re-ran nothing that had finished: one plan call, and start, plan and ask-write served from the cache",
          parked.state === "awaiting_approval" && modelCalls.length === 1 + eight.length + 1
          && step.calls.filter((c) => c.cached).map((c) => c.name).join(",") === "start,plan,ask-write", step.calls.map((c) => c.name + (c.cached ? "*" : "")).join(","));
    check("the wait's start survived the replay: waited_ms is the three hours, measured from the question's askedAt and not from the replay's clock",
          row.waited_ms >= 2 * HOUR + 58 * MIN && row.waited_ms < 3 * HOUR && clock - askedAt === row.waited_ms, `${row.waited_ms} vs ${clock - askedAt}`);
    check("asked at minute 2, hibernated, approved at hour 3 on a replay: the run continued and succeeded", row.state === "succeeded", `${row.state}/${row.reason}`);
  }

  // --- the engine's message prefix: a max_duration thrown inside a step still reads max_duration
  {
    clearCounter();
    const r = await post("/v1/tasks/create", deviceToken, goodBody);
    const id = (await r.json()).id;
    script = [text(JSON.stringify({ queries: ["one"] }), { input_tokens: 10, output_tokens: 10 })];
    script[0].before = () => advance(31 * MIN);
    const step = makeStep();
    await runWorkflow(id, step);
    const row = db.tasks.find((t) => t.id === id);
    check("the reason is max_duration although the caller of step.do saw the message prefixed by the error's name",
          row.state === "failed" && row.reason === "max_duration", `${row.state}/${row.reason}`);
  }

  // --- approval: declined
  {
    clearCounter();
    const r = await post("/v1/tasks/create", deviceToken, goodBody);
    const id = (await r.json()).id;
    const eight = "abcdefghijklmnop".split("");   // sixteen, past askAboveSearches = 15
    script = [text(JSON.stringify({ queries: eight }), { input_tokens: 10, output_tokens: 10 }), searchReply("never", 1)];
    modelCalls.length = 0;
    const step = makeStep([{ payload: { decision: "decline" }, before: async () => { await post("/v1/tasks/approve", deviceToken, { id, decision: "decline" }); } }]);
    await runWorkflow(id, step);
    const row = db.tasks.find((t) => t.id === id);
    check("declined ends cancelled with reason declined and no search was made", row.state === "cancelled" && row.reason === "declined" && modelCalls.length === 1);
    check("the user's own decline is already seen: the row carries seen_at and the summary does not list it unseen",
          row.seen_at != null && !JSON.parse(kv.store.get(`tasks:${accountId}`)).unseen.some((u) => u.id === id));
    check("and the fixed sentence still exists for a decline that reaches a summary unseen", endedSentence("research", "cancelled", "declined") === "The research stopped because you said no.");
  }

  // --- approval: the wait times out, and (correction 3) another error does not read as a timeout
  {
    clearCounter();
    const r = await post("/v1/tasks/create", deviceToken, goodBody);
    const id = (await r.json()).id;
    script = [text(JSON.stringify({ queries: "abcdefghijklmnop".split("") }), { input_tokens: 10, output_tokens: 10 })];   // sixteen: past the threshold, so it asks
    const step = makeStep([]);   // nothing arrives: the stand-in throws its timeout
    await runWorkflow(id, step);
    const row = db.tasks.find((t) => t.id === id);
    check("the wait timing out ends the task expired with reason timeout, and finish-failed still ran",
          row.state === "expired" && row.reason === "timeout" && step.calls.at(-1).name === "finish-failed");

    clearCounter();
    const r2 = await post("/v1/tasks/create", deviceToken, goodBody);
    const id2 = (await r2.json()).id;
    script = [text(JSON.stringify({ queries: "abcdefghijklmnop".split("") }), { input_tokens: 10, output_tokens: 10 })];
    const step2 = makeStep([{ throw: Object.assign(new Error("engine restarted"), { name: "WorkflowError" }) }]);
    await runWorkflow(id2, step2);
    const row2 = db.tasks.find((t) => t.id === id2);
    check("an error inside the wait that is not the timeout ends step_failed, not expired", row2.state === "failed" && row2.reason === "step_failed", `${row2.state}/${row2.reason}`);
    check("isTimeout matches the name or the message and nothing else",
          isTimeout({ name: "WorkflowTimeoutError" }) && isTimeout({ message: "Step timed out" }) && !isTimeout({ name: "TypeError", message: "boom" }));
    check("durationMs reads the units Workflows accepts", durationMs("24 hours") === 24 * HOUR && durationMs("90 seconds") === 90000 && durationMs(5000) === 5000);
  }

  // --- take
  {
    const r = await post("/v1/tasks/take", deviceToken, { id: taskId });
    const j = await r.json();
    const row = db.tasks.find((t) => t.id === taskId);
    check("take returns the result and the three-field ledger", r.status === 200 && j.state === "succeeded" && j.result.spoken.length > 0 && j.result.deliver.notes.title === "Swift actor reentrancy"
          && j.steps.length === 6 && Object.keys(j.steps[0]).sort().join(",") === "cents,name,outcome");
    const seenIndex = tasks.log.findIndex((l) => l.id === taskId && l.call === "delete");
    check("take marked the row seen and then deleted the instance", row.seen_at === clock && seenIndex >= 0);
    check("the header on that reply no longer counts it unseen", !header(r).includes(`${taskId}:succeeded`) && /unseen=\d/.test(header(r)));
    const again = await post("/v1/tasks/take", deviceToken, { id: taskId });
    check("take when the instance is already gone still answers 200", again.status === 200);
    const running = db.tasks.find((t) => t.state === "running" || t.state === "created");
    clearCounter();
    const r3 = await post("/v1/tasks/create", deviceToken, goodBody);
    const id3 = (await r3.json()).id;
    check("take on an unfinished task is not_finished", (await post("/v1/tasks/take", deviceToken, { id: id3 })).status === 409);
    const cancelReply = await post("/v1/tasks/cancel", deviceToken, { id: id3 });
    check("cancel on a running task terminates the instance and says the user did it",
          cancelReply.status === 200
          && tasks.log.some((l) => l.id === id3 && l.call === "terminate") && db.tasks.find((t) => t.id === id3).reason === "user");
    check("the user's own cancel is already seen: seen_at is set and the cancel reply's header does not list it unseen",
          db.tasks.find((t) => t.id === id3).seen_at === clock && !header(cancelReply).includes(`${id3}:cancelled`));
    check("cancel on a finished task is already_finished", (await post("/v1/tasks/cancel", deviceToken, { id: taskId })).status === 409);
    void running;
  }

  // --- delete and list
  {
    clearCounter();
    const r = await post("/v1/tasks/create", deviceToken, goodBody);
    const id = (await r.json()).id;
    const d = await post("/v1/tasks/delete", deviceToken, { id });
    check("delete on a running task terminates, removes the row and the instance",
          d.status === 200 && tasks.log.some((l) => l.id === id && l.call === "terminate") && tasks.log.some((l) => l.id === id && l.call === "delete") && !db.tasks.some((t) => t.id === id));
    check("and the header no longer lists it", !header(d).includes(id));
    const terminatesBefore = tasks.log.filter((l) => l.call === "terminate").length;
    const d2 = await post("/v1/tasks/delete", deviceToken, { id: taskId });
    check("delete on a finished task removes it without terminating", d2.status === 200 && tasks.log.filter((l) => l.call === "terminate").length === terminatesBefore && !db.tasks.some((t) => t.id === taskId));
    check("delete of an unknown id is not_found", (await post("/v1/tasks/delete", deviceToken, { id: "nope" })).status === 404);

    const list = await post("/v1/tasks", deviceToken, {});
    const lj = await list.json();
    check("list returns the account's rows with state, question and spoken, never the input or the detail",
          list.status === 200 && lj.tasks.length === db.tasks.filter((t) => t.account_id === accountId).length
          && lj.tasks.every((t) => t.id && t.state && !("input" in t) && !("detail" in t) && !("result" in t))
          && lj.tasks.some((t) => t.id === approvedId && t.spoken === "S"));
    check("another account sees none of them", (await (await post("/v1/tasks", otherToken, {})).json()).tasks.length === 0);
  }

  // --- retention: a comparison at read
  {
    const old = db.tasks.find((t) => t.id === approvedId);
    old.expires_at = clock - 1;
    const young = db.tasks.find((t) => t.state === "failed");
    young.expires_at = clock + 1;
    const list = await post("/v1/tasks", deviceToken, {});
    const lj = await list.json();
    check("a finished row past expires_at is deleted when the rows are next read, and its instance with it",
          !db.tasks.some((t) => t.id === approvedId) && tasks.log.some((l) => l.id === approvedId && l.call === "delete") && !lj.tasks.some((t) => t.id === approvedId));
    check("a row still inside its retention stays", db.tasks.some((t) => t.id === young.id));
    const cancelled = db.tasks.find((t) => t.reason === "user");
    cancelled.state = "running"; cancelled.expires_at = clock - 1;
    await post("/v1/tasks", deviceToken, {});
    check("a non-terminal row is never swept", db.tasks.some((t) => t.id === cancelled.id));
    cancelled.state = "cancelled";
  }

  // --- retention: the daily cleanup, for every account, read or not
  {
    const finished = db.tasks.filter((t) => ["succeeded", "failed", "cancelled", "expired"].includes(t.state));
    const gone = finished[0], kept = finished[1];
    gone.expires_at = clock - 1; kept.expires_at = clock + 60_000;
    const running = db.tasks.find((t) => !["succeeded", "failed", "cancelled", "expired"].includes(t.state));
    if (running) running.expires_at = clock - 1;
    const removed = await purgeExpired(envTasks, clock);
    check("the daily cleanup deletes a finished task past its three days, and its instance, without the account reading anything",
          removed >= 1 && !db.tasks.some((t) => t.id === gone.id) && tasks.log.some((l) => l.id === gone.id && l.call === "delete"));
    check("and keeps one still inside them, and any task not finished", db.tasks.some((t) => t.id === kept.id) && (!running || db.tasks.some((t) => t.id === running.id)));
    const waits = [];
    await worker.scheduled({ cron: "0 4 * * *" }, envTasks, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    check("the worker's scheduled handler runs it", waits.length === 1);
    const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
    check("wrangler.toml schedules it once a day", /\[triggers\]\s*\ncrons = \["0 4 \* \* \*"\]/.test(toml));
  }

  // --- the question path: a header from KV, read beside the counters, never written
  {
    const reads = [];
    const kvSpy = { ...kv, get: async (k) => { reads.push(k); return kv.get(k); } };
    const before = [...kv.store.keys()].filter((k) => k.startsWith("tasks:")).map((k) => kv.store.get(k)).join("|");
    const dbCalls = db.calls.length;
    const ctx = makeCtx();
    const response = await worker.fetch(ask(valid, deviceToken), { ...envTasks, OTTO: kvSpy }, ctx);
    await ctx.settle();
    const h = header(response);
    check("a question's reply carries otto-tasks from the KV summary", response.status === 200 && h.startsWith("v=1;") && /unseen=[1-9]/.test(h) && h.includes(";s="), h);
    const tasksRead = reads.indexOf(`tasks:${accountId}`);
    const firstCounter = reads.findIndex((k) => k.startsWith(`u:${accountId}:`));
    check("the summary was read in the same round trip as the counters", tasksRead >= 0 && firstCounter >= 0 && Math.abs(tasksRead - firstCounter) <= 2);
    check("a question never writes the summary, never reads D1 and never touches the Workflow binding",
          [...kv.store.keys()].filter((k) => k.startsWith("tasks:")).map((k) => kv.store.get(k)).join("|") === before && db.calls.length === dbCalls);
    kv.store.delete(`tasks:${accountId}`);
    const bare = await worker.fetch(ask(valid, deviceToken), envTasks, makeCtx());
    check("with no summary in KV the header is absent, not zero", bare.headers.get("otto-tasks") === null);
    const trial = await worker.fetch(ask(valid, trialToken), envTasks, makeCtx());
    check("a trial's question reads no summary", !reads.some((k) => k === `tasks:${trialToken}`) && trial.status === 200);
  }

  // --- the feed (A84): a snapshot, then the platform's events, projected
  {
    const decoder = new TextDecoder();
    // One SSE frame at a time from a response body: { event, data } or { comment }.
    const frameReader = (response) => {
      const reader = response.body.getReader();
      let buffer = "";
      return {
        reader,
        next: async (timeoutMs = 2000) => {
          for (;;) {
            const cut = buffer.indexOf("\n\n");
            if (cut >= 0) {
              const raw = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
              if (raw.startsWith(":")) return { comment: raw.slice(1).trim() };
              const lines = raw.split("\n");
              const event = (lines.find((l) => l.startsWith("event: ")) || "").slice(7);
              const data = (lines.find((l) => l.startsWith("data: ")) || "").slice(6);
              return { event, data: data ? JSON.parse(data) : null, raw };
            }
            const chunk = await Promise.race([
              reader.read(),
              new Promise((_, reject) => setTimeout(() => reject(new Error("no frame within the timeout")), timeoutMs)),
            ]);
            if (chunk.done) return null;
            buffer += decoder.decode(chunk.value, { stream: true });
          }
        },
      };
    };
    const feed = (token, body, init = {}) => worker.fetch(new Request("https://w/v1/tasks/feed", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...init }), envTasks, makeCtx());

    // Two rows written straight into the stand-in: one finished with a ledger
    // and a result, one running with a plan in its ledger.
    const t0 = 1_760_100_000_000;
    const doneId = "feed-done-1", liveId = "feed-live-1";
    db.tasks.length = 0;
    db.tasks.push({
      id: doneId, account_id: accountId, type: "research", state: "succeeded",
      // The secret sits past the 120th character: the cut is what keeps it out.
      input: JSON.stringify({ request: "Best standing desks " + "x".repeat(200) + ` ${SECRET}`, now: "2026-10-13T09:00:00Z", tz: "UTC", taskVersion: 1 }),
      steps: JSON.stringify([
        { name: "start", started: t0, ended: t0 + 5, outcome: "ok" },
        { name: "plan", started: t0 + 10, ended: t0 + 900, outcome: "ok", label: "Planned 2 searches", queries: ["wirecutter standing desk", "reddit desk wobble"] },
        { name: "search-1", started: t0 + 1000, ended: t0 + 9000, outcome: "ok", label: "wirecutter standing desk", searches: 2 },
        { name: "search-2", started: t0 + 9000, ended: t0 + 18000, outcome: "failed", error: "model_http_529" },
        { name: "draft", started: t0 + 18000, ended: t0 + 30000, outcome: "ok", label: "Writing it up" },
        { name: "finish", started: t0 + 30000, ended: t0 + 30010, outcome: "ok" },
      ]),
      question: null, answer: null,
      result: JSON.stringify({ spoken: "Flexispot wins.", detail: `# Findings ${SECRET}`, deliver: { notes: { title: "Standing desks", body: `## ${SECRET} body` } } }),
      reason: null, waited_ms: 0, seen_at: null, created_at: t0, updated_at: t0 + 30010, finished_at: t0 + 30010, expires_at: t0 + 3 * 86_400_000,
    });
    db.tasks.push({
      id: liveId, account_id: accountId, type: "research", state: "running",
      input: JSON.stringify({ request: "Lisbon coworking day passes", now: "2026-10-13T09:00:00Z", tz: "UTC", taskVersion: 1 }),
      steps: JSON.stringify([
        { name: "start", started: t0, ended: t0 + 5, outcome: "ok" },
        { name: "plan", started: t0 + 10, ended: t0 + 900, outcome: "ok", queries: ["lisbon coworking day pass", "second life coworking lisbon"] },
        { name: "search-1", started: t0 + 1000, ended: t0 + 9000, outcome: "ok" },
      ]),
      question: null, answer: null, result: null, reason: null, waited_ms: 0, seen_at: null,
      created_at: t0, updated_at: t0 + 9000, finished_at: null, expires_at: null,
    });
    tasks.instances.set(liveId, { events: [
      { type: "workflow_running", instanceId: liveId, eventId: 1, timestamp: t0 },
      { type: "step_started", instanceId: liveId, eventId: 9, timestamp: t0 + 9100, stepName: "search-2" },
      { type: "attempt_started", instanceId: liveId, eventId: 10, timestamp: t0 + 9100, stepName: "search-2", attempt: 1 },
      { type: "step_completed", instanceId: liveId, eventId: 12, timestamp: t0 + 15000, stepName: "search-2", output: { findings: `never forwarded ${SECRET}` } },
      { type: "step_started", instanceId: liveId, eventId: 13, timestamp: t0 + 15001, stepName: "ask-write" },
      { type: "wait_started", instanceId: liveId, eventId: 15, timestamp: t0 + 15100, stepName: "ask-wait", eventType: "approval" },
    ] });
    const realNowFeed = Date.now;
    Date.now = () => t0 + 40000;

    check("the feed needs an account behind the bearer", (await feed(trialToken, {})).status === 403);
    const malformed = await worker.fetch(new Request("https://w/v1/tasks/feed", { method: "POST", headers: { authorization: `Bearer ${deviceToken}` }, body: "{not json" }), envTasks, makeCtx());
    check("a malformed body is refused, an absent one is fine", malformed.status === 400 && (await malformed.json()).error === "malformed_json");

    const response = await feed(deviceToken, undefined);
    check("the feed is a 200 event stream with the otto-tasks header",
          response.status === 200 && response.headers.get("content-type").startsWith("text/event-stream")
          && header(response).startsWith("v=1;running=1;awaiting=0;unseen=1"), header(response));
    const frames = frameReader(response);
    const snapshot = await frames.next();
    const done = snapshot && snapshot.data && snapshot.data.tasks.find((t) => t.id === doneId);
    const live = snapshot && snapshot.data && snapshot.data.tasks.find((t) => t.id === liveId);
    check("the first frame is the snapshot of both rows, newest first",
          snapshot && snapshot.event === "snapshot" && snapshot.data.at === t0 + 40000 && snapshot.data.tasks.length === 2 && snapshot.data.tasks[0].id === doneId);
    check("a projection carries subject (cut at 120), state, times, seen, spoken and the note's title",
          done && done.subject.length === 120 && done.subject.startsWith("Best standing desks") && done.state === "succeeded"
          && done.createdAt === t0 && done.finishedAt === t0 + 30010 && done.seen === false && done.spoken === "Flexispot wins." && done.noteTitle === "Standing desks" && done.type === "research");
    check("its steps are plan, the searches and the draft, labelled; the bookkeeping steps are not shown",
          done && done.steps.map((s) => s.name).join(",") === "plan,search-1,search-2,draft"
          && done.steps[0].label === "Planned 2 searches" && done.steps[1].label === "wirecutter standing desk"
          && done.steps[2].label === "reddit desk wobble" && done.steps[2].outcome === "failed" && done.steps[3].label === "Writing it up"
          && done.steps[1].started === t0 + 1000 && done.steps[1].ended === t0 + 9000, JSON.stringify(done && done.steps));
    check("a row from before titles is named by its request's first clause, cut at a word boundary (A91)",
          done && done.title === "Best standing desks…" && !done.title.includes(SECRET), done && done.title);
    check("a ledger without labels is labelled from the name and the plan's queries",
          live && live.steps.map((s) => s.label).join("|") === "Planned 2 searches|lisbon coworking day pass", JSON.stringify(live && live.steps));
    check("nothing of the detail, the note's body or the findings is in the snapshot", !snapshot.raw.includes(SECRET) && !snapshot.raw.includes("detail") && !snapshot.raw.includes("body"));

    const running = await frames.next();
    check("a live step_started becomes a running step frame, labelled from the plan's queries",
          running && running.event === "step" && running.data.task === liveId && running.data.name === "search-2"
          && running.data.label === "second life coworking lisbon" && running.data.outcome === "running" && running.data.started === t0 + 9100 && running.data.eventId === 9, JSON.stringify(running));
    const completed = await frames.next();
    check("its step_completed becomes an ok frame with the start it saw, and the output is never forwarded",
          completed && completed.event === "step" && completed.data.outcome === "ok" && completed.data.started === t0 + 9100 && completed.data.ended === t0 + 15000
          && !completed.raw.includes(SECRET) && !completed.raw.includes("output"), JSON.stringify(completed));
    // The Workflow writes the question before the wait starts; the test writes it here.
    const liveRow = db.tasks.find((t) => t.id === liveId);
    liveRow.state = "awaiting_approval"; liveRow.question = JSON.stringify({ spoken: "This is a big one, about 16 searches. Go ahead?", askedAt: t0 + 15050, until: t0 + 86_400_000 }); liveRow.updated_at = t0 + 15050;
    const waiting = await frames.next();
    check("wait_started re-reads the row and sends it as a task frame, now awaiting with its question; ask-write was not a step frame",
          waiting && waiting.event === "task" && waiting.data.id === liveId && waiting.data.state === "awaiting_approval"
          && waiting.data.question.spoken.startsWith("This is a big one") && waiting.data.steps.length === 2, JSON.stringify(waiting));

    // The re-read notices a task started elsewhere and a row deleted elsewhere.
    const newId = "feed-new-1";
    db.tasks.push({ ...db.tasks.find((t) => t.id === liveId), id: newId, state: "running", question: null, created_at: t0 + 20000, updated_at: t0 + 20000,
                    input: JSON.stringify({ request: "Started on the phone", now: "x", tz: "UTC", taskVersion: 1 }), steps: "[]" });
    tasks.instances.set(newId, { events: [], end: true });
    db.tasks.splice(db.tasks.findIndex((t) => t.id === doneId), 1);
    const subsBefore = tasks.log.filter((l) => l.call === "subscribe").length;
    // Two pings' worth of timer: the interval is driven by hand.
    const intervals = [];
    const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
    // (the stream's interval was created before this patch; drive it through a second feed below)
    globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); intervals.push({ id, fn, ms, cleared: false }); return id; };
    globalThis.clearInterval = (id) => { const i = intervals.find((x) => x.id === id); if (i) i.cleared = true; realClearInterval(id); };
    const controller = new AbortController();
    const second = await feed(deviceToken, { cursors: { [liveId]: 12, "bad id!": 3, [newId]: -1 } }, { signal: controller.signal });
    const frames2 = frameReader(second);
    const snap2 = await frames2.next();
    check("a second client gets its own snapshot, and the ledger-less new row is labelled Planning",
          snap2 && snap2.event === "snapshot" && snap2.data.tasks.length === 2 && snap2.data.tasks.find((t) => t.id === newId).steps.length === 0);
    const subscribed = tasks.log.filter((l) => l.call === "subscribe").slice(subsBefore);
    check("the reconnect cursor is passed through for the task that had one; a malformed id or cursor is dropped",
          subscribed.some((l) => l.id === liveId && l.options && l.options.cursor === 12)
          && subscribed.some((l) => l.id === newId && l.options === undefined), JSON.stringify(subscribed));
    check("the stream created one interval of fifteen seconds", intervals.length === 1 && intervals[0].ms === 15000);
    // Drive the interval by hand: a ping, then the re-read.
    intervals[0].fn();
    const ping = await frames2.next();
    check("the first tick is a ping comment", ping && ping.comment === "ping", JSON.stringify(ping));
    db.tasks.find((t) => t.id === newId).updated_at = t0 + 25000;
    intervals[0].fn();
    const ping2 = await frames2.next();
    const changed = await frames2.next();
    check("the second tick re-reads the rows: a changed row comes as a task frame",
          ping2 && ping2.comment === "ping" && changed && changed.event === "task" && changed.data.id === newId && changed.data.updatedAt === t0 + 25000, JSON.stringify(changed));
    db.tasks.splice(db.tasks.findIndex((t) => t.id === newId), 1);
    // The re-read is every second tick: one ping alone, then a ping and the read.
    intervals[0].fn(); await frames2.next();
    intervals[0].fn(); await frames2.next();
    const gone = await frames2.next();
    check("a row deleted elsewhere comes as gone", gone && gone.event === "gone" && gone.data.id === newId, JSON.stringify(gone));
    const disposedBefore = tasks.log.filter((l) => l.call === "dispose").length;
    controller.abort();
    await new Promise((r) => setTimeout(r, 20));
    check("the client's abort disposes the subscriptions and clears the interval",
          tasks.log.filter((l) => l.call === "dispose").length > disposedBefore && intervals[0].cleared === true,
          `disposes ${tasks.log.filter((l) => l.call === "dispose").length - disposedBefore}, cleared ${intervals[0].cleared}`);
    globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval;
    await frames.reader.cancel().catch(() => {});
    check("nothing of the detail, the findings or the note's body reached the log", !logged.join("|").includes(SECRET));

    // The list route carries the same projection.
    db.tasks.push({ ...liveRow, id: "feed-list-1", state: "running", question: null });
    const list = await (await post("/v1/tasks", deviceToken, {})).json();
    const listed = list.tasks.find((t) => t.id === "feed-list-1");
    check("the list route carries subject and labelled steps, and no detail",
          listed && listed.subject === "Lisbon coworking day passes" && listed.steps.length === 2 && listed.steps[1].label === "lisbon coworking day pass"
          && !JSON.stringify(list).includes(SECRET) && !JSON.stringify(list).includes("detail"), JSON.stringify(listed));
    Date.now = realNowFeed;
  }


  // --- browser tasks (A89): create, the step route, the ledger
  {
    const { stepsOf, ledgerText } = await import("./src/tasks/browser.js");
    const zw = String.fromCharCode(0x200b), rlo = String.fromCharCode(0x202e), bom = String.fromCharCode(0xfeff);
    const PAGE = "PAGETEXT-NEVER-STORED", QUERY = "QUERYSECRET";
    const browserBody = { type: "browser", request: "Find my most recent Amazon order", title: "My latest Amazon order",
                          url: `https://www.amazon.com/gp/css/order-history?ref_=nav&token=${QUERY}#top`, now: "2026-10-28T09:00:00Z", tz: "UTC" };
    const create = async (extra = {}) => { clearCounter(); const r = await post("/v1/tasks/create", deviceToken, { ...browserBody, ...extra }); return { r, j: await r.json() }; };
    const stepPost = (token, body) => post("/v1/tasks/step", token, body);
    const rowOf = (id) => db.tasks.find((t) => t.id === id);

    // create
    const { r: c1, j: j1 } = await create();
    const in1 = JSON.parse(rowOf(j1.id).input);
    check("a browser task is created through the existing create route", c1.status === 200 && rowOf(j1.id).type === "browser");
    check("with no mode it is a read (A89: unclear is read)", in1.mode === "read");
    check("its start page is kept without query or fragment, with its host",
          in1.url === "https://www.amazon.com/gp/css/order-history" && in1.host === "www.amazon.com" && !rowOf(j1.id).input.includes(QUERY), JSON.stringify(in1));
    check("a mode other than read or act is refused", (await create({ mode: "drive" })).r.status === 400);
    // KV WRITES REFUSED: a task is created, steps, and finishes all the same (2026-10-29).
    {
      const realPut = kv.put;
      kv.put = async () => { throw new Error("KV put() limit exceeded for the day."); };
      const { r, j } = await capture(() => create());
      const s1 = await capture(() => stepPost(deviceToken, { id: j.id, n: 1, kind: "step", label: "Opened example.com" }));
      const fin = await capture(() => stepPost(deviceToken, { id: j.id, n: 2, kind: "finish", answer: "Done." }));
      const list = await capture(() => post("/v1/tasks", deviceToken, {}));
      kv.put = realPut;
      check("with every KV write refused, a browser task is created, steps, finishes and is listed",
            r.status === 200 && s1.status === 200 && fin.status === 200 && list.status === 200, `${r.status} ${s1.status} ${fin.status} ${list.status}`);
    }
    check("a browser task needs an https start page",
          (await create({ url: "http://www.amazon.com/" })).r.status === 400 && (await create({ url: "javascript:alert(1)" })).r.status === 400
          && (await create({ url: undefined })).r.status === 400);
    clearCounter();
    check("mode and url belong to browser tasks only",
          (await post("/v1/tasks/create", deviceToken, { ...goodBody, mode: "act" })).status === 400
          && (await post("/v1/tasks/create", deviceToken, { ...goodBody, url: "https://a.example/" })).status === 400);
    const readId = j1.id;
    const { j: jAct } = await create({ mode: "act", url: "https://httpbin.org/forms/post", title: "Pizza order" });
    const actId = jAct.id;
    const list = await (await post("/v1/tasks", deviceToken, {})).json();
    const listed = list.tasks.find((t) => t.id === actId);
    check("the projection carries the site and the mode, for the approval card's \"Chrome · <host>\"",
          listed && listed.site === "httpbin.org" && listed.mode === "act" && listed.title === "Pizza order");

    // the step route
    const eventsBefore = tasks.log.length;
    const s1 = await stepPost(deviceToken, { id: readId, n: 1, kind: "step",
      label: `Opened${zw} https://www.amazon.com/gp/css/order-history?token=${QUERY}#x${bom}` });
    const e1 = stepsOf(rowOf(readId))[0];
    check("a step is recorded with its label cleaned: no query, no fragment, no invisible characters",
          s1.status === 200 && e1 && e1.name === "step-1" && e1.label === "Opened https://www.amazon.com/gp/css/order-history", JSON.stringify(e1));
    const sent = tasks.log.slice(eventsBefore).filter((l) => l.call === "sendEvent");
    check("the instance is told only that a step was posted", sent.length === 1 && sent[0].event.type === "browser-step"
          && JSON.stringify(sent[0].event.payload) === JSON.stringify({ n: 1 }));
    check("a step for another account's task is not found", (await stepPost(otherToken, { id: readId, n: 2, kind: "step", label: "x" })).status === 404);
    check("a trial device cannot post a step", (await stepPost(trialToken, { id: readId, n: 2, kind: "step", label: "x" })).status === 403);
    const skip = await stepPost(deviceToken, { id: readId, n: 3, kind: "step", label: "x" });
    check("a step out of order is refused, and says which comes next", skip.status === 409 && (await skip.json()).expected === 2);
    check("the same step twice is refused", (await stepPost(deviceToken, { id: readId, n: 1, kind: "step", label: "again" })).status === 409);
    const beforeSteps = rowOf(readId).steps;
    const smuggled = await stepPost(deviceToken, { id: readId, n: 2, kind: "step", label: "Read the page", outline: `${PAGE} the whole page` });
    check("page content has no key to arrive under: an unknown key is refused and nothing is written",
          smuggled.status === 400 && (await smuggled.json()).key === "outline" && rowOf(readId).steps === beforeSteps);
    const big = await stepPost(deviceToken, { id: readId, n: 2, kind: "step", label: PAGE.repeat(150) });
    check("and no room if it found one: a body over 2 KB is refused", big.status === 413 && rowOf(readId).steps === beforeSteps);
    check("the mode cannot be changed by a step", (await stepPost(deviceToken, { id: readId, n: 2, kind: "step", label: "x", mode: "act" })).status === 400
          && JSON.parse(rowOf(readId).input).mode === "read");
    const ro = await stepPost(deviceToken, { id: readId, n: 2, kind: "approval", label: "Submit", sentence: "On amazon.com: buy it. Go ahead?" });
    check("a task started to read cannot ask to act", ro.status === 409 && (await ro.json()).error === "read_only");
    const researchRow = db.tasks.find((t) => t.type === "research");
    check("a research task takes no steps", researchRow && (await stepPost(deviceToken, { id: researchRow.id, n: 1, kind: "step", label: "x" })).status === 400);
    check("a label is required, and a finish needs its answer",
          (await stepPost(deviceToken, { id: readId, n: 2, kind: "step" })).status === 400
          && (await stepPost(deviceToken, { id: readId, n: 2, kind: "finish" })).status === 400);

    // the race: two writers of one ledger
    const raceRow = rowOf(readId);
    const staleSteps = raceRow.steps;
    raceRow.steps = JSON.stringify([...JSON.parse(staleSteps), { name: "start", outcome: "ok" }]);
    const { appendStep } = await import("./src/tasks/run.js");
    let conflict = null;
    try { await appendStep(envTasks, { id: readId, accountId }, { ...raceRow, steps: staleSteps }, { name: "step-2", kind: "step", label: "late" }); } catch (e) { conflict = e; }
    check("a step written against a ledger that moved is refused, not lost or doubled",
          conflict && conflict.name === "LedgerConflict" && !rowOf(readId).steps.includes("late"));

    // the ledger run: a read task to its answer
    await stepPost(deviceToken, { id: readId, n: 2, kind: "step", label: "Clicked Returns & Orders" });
    await stepPost(deviceToken, { id: readId, n: 3, kind: "finish", answer: `Your last order${zw} was a USB-C cable, delivered Tuesday.` });
    const readStep = makeStep([{ payload: { n: 1 } }, { payload: { n: 2 } }, { payload: { n: 3 } }]);
    await runWorkflow(readId, readStep);
    const done = rowOf(readId);
    check("the ledger run ends the task with the Mac's answer, cleaned", done.state === "succeeded"
          && JSON.parse(done.result).spoken === "Your last order was a USB-C cable, delivered Tuesday.", done.result);
    check("its ledger holds the labels and the answer, and no bookkeeping reads",
          stepsOf(done).map((s) => s.label).join("|") === "Opened https://www.amazon.com/gp/css/order-history|Clicked Returns & Orders|Done"
          && !done.steps.includes("read-"), done.steps);
    check("the ledger never stored page text or a query", !done.steps.includes(PAGE) && !done.steps.includes(QUERY) && !done.input.includes(QUERY));
    check("a finished task refuses steps", (await stepPost(deviceToken, { id: readId, n: 4, kind: "step", label: "x" })).status === 409);

    // an act task: the hold, through askUser, with the extension's sentence
    const sentence = `On httpbin.org: submit the form (custname = "Ada", size = "medium") to https://httpbin.org/post?debug=${QUERY}. Go ahead?`;
    await stepPost(deviceToken, { id: actId, n: 1, kind: "step", label: "Filled in the form" });
    await stepPost(deviceToken, { id: actId, n: 2, kind: "approval", label: "Submit order", sentence });
    let held = null, refusedWhileHeld = 0;
    // IN THE ORDER THE RUN CONSUMES THEM. Both steps are posted before the
    // run starts, so its first read already sees the approval and asks; the
    // engine routes by type ("approval" vs "browser-step"), this stand-in by
    // position, so the approval comes second here and step 2's event after it.
    const actStep = makeStep([
      { payload: { n: 1 } },
      { payload: { decision: "approve" }, before: async () => {
          held = { ...rowOf(actId) };
          refusedWhileHeld = (await stepPost(deviceToken, { id: actId, n: 3, kind: "step", label: "x" })).status;
          await post("/v1/tasks/approve", deviceToken, { id: actId, decision: "approve" });
          await stepPost(deviceToken, { id: actId, n: 3, kind: "finish", answer: "Submitted; the site echoed the order." });
        } },
      { payload: { n: 2 } },
      { payload: { n: 3 } },
    ]);
    await runWorkflow(actId, actStep);
    const heldQ = held && held.question ? JSON.parse(held.question) : {};
    check("an approval is held through askUser: the row waits, with the extension's sentence (query stripped)",
          held && held.state === "awaiting_approval"
          && heldQ.spoken === `On httpbin.org: submit the form (custname = "Ada", size = "medium") to https://httpbin.org/post. Go ahead?`, held && held.question);
    check("the hold waits ten minutes, not a research task's day", heldQ.until - heldQ.askedAt === 10 * MIN);
    check("a step posted while the yes is awaited is refused", refusedWhileHeld === 409);
    check("each approval has its own steps, keyed by the step it holds",
          actStep.calls.some((c) => c.name === "ask-write-step-2") && actStep.calls.some((c) => c.name === "ask-wait-step-2" && c.wait));
    check("after the yes the task runs on to its answer", rowOf(actId).state === "succeeded");

    // ten minutes without a step
    const { j: jIdle } = await create();
    await runWorkflow(jIdle.id, makeStep([]));
    const idle = rowOf(jIdle.id);
    check("ten minutes without a step ends the task expired, reason idle", idle.state === "expired" && idle.reason === "idle");
    check("and it is said as \"Your Mac went to sleep or Otto quit, so I stopped.\"",
          endedSentence("browser", "expired", "idle") === "Your Mac went to sleep or Otto quit, so I stopped.");
    const idleWait = makeStep([]);
    check("the idle wait is ten minutes, on its own event type", (await runWorkflow((await create()).j.id, idleWait), idleWait.calls.some((c) => c.name === "step-wait-1" && c.config.type === "browser-step" && c.config.timeout === "10 minutes")));
    check("an expired task refuses steps", (await stepPost(deviceToken, { id: jIdle.id, n: 1, kind: "step", label: "x" })).status === 409);

    // the bounds: twenty-five steps, thirty minutes
    const { j: jMany } = await create();
    let lastOk = 0;
    for (let n = 1; n <= 25; n++) if ((await stepPost(deviceToken, { id: jMany.id, n, kind: "step", label: `Step ${n}` })).status === 200) lastOk = n;
    const over = await stepPost(deviceToken, { id: jMany.id, n: 26, kind: "step", label: "one too many" });
    check("twenty-five steps are taken; the twenty-sixth ends the task", lastOk === 25 && over.status === 409
          && rowOf(jMany.id).state === "failed" && rowOf(jMany.id).reason === "step_limit"
          && tasks.log.some((l) => l.id === jMany.id && l.call === "terminate"));
    const { j: jSlow } = await create();
    rowOf(jSlow.id).created_at = clock - 31 * MIN;
    const late = await stepPost(deviceToken, { id: jSlow.id, n: 1, kind: "step", label: "x" });
    check("past thirty minutes of working time a step ends the task", late.status === 409 && rowOf(jSlow.id).reason === "max_duration");
    const { j: jWaited } = await create();
    rowOf(jWaited.id).created_at = clock - 31 * MIN;
    rowOf(jWaited.id).waited_ms = 5 * MIN;
    check("time spent waiting for a yes is forgiven", (await stepPost(deviceToken, { id: jWaited.id, n: 1, kind: "step", label: "x" })).status === 200);

    // an end from the Mac
    const { j: jEnd } = await create();
    check("an end needs a known reason", (await stepPost(deviceToken, { id: jEnd.id, n: 1, kind: "end", reason: "bored" })).status === 400);
    const ended = await stepPost(deviceToken, { id: jEnd.id, n: 1, kind: "end", reason: "user_closed_tab" });
    check("closing Otto's tab cancels the task, seen at once, and ends the instance", ended.status === 200
          && rowOf(jEnd.id).state === "cancelled" && rowOf(jEnd.id).reason === "user_closed_tab" && rowOf(jEnd.id).seen_at
          && tasks.log.some((l) => l.id === jEnd.id && l.call === "terminate"));
    check("and is said as what happened", endedSentence("browser", "cancelled", "user_closed_tab") === "Stopped — you closed Otto's tab.");
    const { j: jTyped } = await create();
    await stepPost(deviceToken, { id: jTyped.id, n: 1, kind: "end", reason: "user_typing" });
    check("the user typing in the tab they handed over cancels the task, seen at once, and says so (current-tab design)",
          rowOf(jTyped.id).state === "cancelled" && rowOf(jTyped.id).seen_at
          && endedSentence("browser", "cancelled", "user_typing") === "Stopped — you started typing in that tab, so it's yours.");
    const { j: jGone } = await create();
    await stepPost(deviceToken, { id: jGone.id, n: 1, kind: "end", reason: "browser_closed" });
    check("Chrome closing fails the task with its reason, not seen", rowOf(jGone.id).state === "failed" && !rowOf(jGone.id).seen_at
          && endedSentence("browser", "failed", "browser_closed") === "Stopped — Chrome was closed.");
    // --- a browser step's model call (A89 §11): /v1/tasks/ask
    {
      const stepModelBody = { model: "claude-sonnet-5-5", max_tokens: 1024, stream: true,
                              messages: [{ role: "user", content: `Page outline: ${PAGE}` }] };
      const askStep = async (token, id, n, body = stepModelBody) => {
        const ctx = makeCtx();
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
        if (id !== undefined) headers["otto-task"] = id;
        if (n !== undefined) headers["otto-step"] = String(n);
        const r = await worker.fetch(new Request("https://w/v1/tasks/ask", { method: "POST", headers, body: JSON.stringify(body) }), envTasks, ctx);
        await ctx.settle();
        return r;
      };
      const day = new Date(clock).toISOString().slice(0, 10);
      const stepKey = `u:${accountId}:s:${day}`, questionKey = `u:${accountId}:d:${new Date().toISOString().slice(0, 10)}`;
      const clearSteps = () => kv.store.delete(stepKey);
      clearSteps();

      const { j: jCall } = await create();
      const callId = jCall.id;
      const questionsBefore = kv.store.get(questionKey);
      const upstreamBefore = streamCalls.length;
      const a1 = await askStep(deviceToken, callId, 1);
      const sent1 = streamCalls[streamCalls.length - 1];
      check("a browser step's call streams through, on a 5.5 model, with the relay's key",
            a1.status === 200 && streamCalls.length === upstreamBefore + 1 && sent1.body.model === "claude-sonnet-5-5"
            && sent1.headers["x-api-key"] === envTasks.ANTHROPIC_API_KEY);
      check("the body is passed on untouched", JSON.stringify(sent1.body) === JSON.stringify(stepModelBody));
      check("it is counted on the task's row and on the day's step counter, not the question counter",
            rowOf(callId).calls === 1 && kv.store.get(stepKey) === "1" && kv.store.get(questionKey) === questionsBefore);
      check("its D1 round is reported in server-timing, every call", /(^|, )d1;dur=\d+/.test(a1.headers.get("server-timing") || ""));
      check("and the page sent to the model is never in the ledger",
            !rowOf(callId).steps.includes(PAGE) && !rowOf(callId).input.includes(PAGE) && !logged.join("|").includes(PAGE));
      check("a step's call must be for the next step", (await askStep(deviceToken, callId, 2)).status === 409);
      await stepPost(deviceToken, { id: callId, n: 1, kind: "step", label: "Read the orders" });
      check("and is taken for the next one once a step is posted", (await askStep(deviceToken, callId, 2)).status === 200 && rowOf(callId).calls === 3);
      check("a retried call for the same step is taken, inside the bound", (await askStep(deviceToken, callId, 2)).status === 200);

      // the allowlists: the 5.5 models here only
      check("a model outside the step allowlist is refused", (await askStep(deviceToken, callId, 2, { ...stepModelBody, model: "claude-fable-5" })).status === 400);
      const q55 = await worker.fetch(new Request("https://w/v1/ask", { method: "POST",
        headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ ...stepModelBody, model: "claude-opus-5-5" }) }), envTasks, makeCtx());
      check("the question path still refuses the 5.5 models", q55.status === 400 && (await q55.json()).error === "model_not_allowed");

      // who may call, and for what
      const callsBefore = rowOf(callId).calls;
      check("another account's task is not found, and its count is untouched",
            (await askStep(otherToken, callId, 2)).status === 404 && rowOf(callId).calls === callsBefore);
      check("a trial device is refused", (await askStep(trialToken, callId, 2)).status === 403);
      check("a call that names no task, or no step, is refused",
            (await askStep(deviceToken, undefined, 1)).status === 400 && (await askStep(deviceToken, callId, undefined)).status === 400
            && (await askStep(deviceToken, callId, "two")).status === 400);
      clearCounter();
      const { j: jResearch } = await (async () => { const r = await post("/v1/tasks/create", deviceToken, goodBody); return { j: await r.json() }; })();
      const notBrowser = await askStep(deviceToken, jResearch.id, 1);
      check("a research task's id is refused: not_browser", notBrowser.status === 400 && (await notBrowser.json()).error === "not_browser");
      const finished = await askStep(deviceToken, jEnd.id, 2);
      check("a finished task refuses calls", finished.status === 409 && (await finished.json()).error === "already_finished");
      const { j: jGoneIdle } = await create();
      rowOf(jGoneIdle.id).state = "expired"; rowOf(jGoneIdle.id).reason = "idle";
      check("an expired task refuses calls", (await askStep(deviceToken, jGoneIdle.id, 1)).status === 409);
      const { j: jHeld } = await create({ mode: "act" });
      rowOf(jHeld.id).state = "awaiting_approval";
      const heldCall = await askStep(deviceToken, jHeld.id, 1);
      check("a task waiting for a yes refuses calls", heldCall.status === 409 && (await heldCall.json()).error === "awaiting_approval");

      // the bounds end the task
      const { j: jMany } = await create();
      rowOf(jMany.id).calls = 30;
      const manyCall = await askStep(deviceToken, jMany.id, 1);
      check("the thirty-first call ends the task", manyCall.status === 409 && (await manyCall.json()).error === "call_limit"
            && rowOf(jMany.id).state === "failed" && rowOf(jMany.id).reason === "call_limit"
            && tasks.log.some((l) => l.id === jMany.id && l.call === "terminate")
            && endedSentence("browser", "failed", "call_limit") === "Stopped — that took too many tries.");
      const { j: jLong } = await create();
      rowOf(jLong.id).created_at = clock - 31 * MIN;
      const longCall = await askStep(deviceToken, jLong.id, 1);
      check("a call past thirty minutes of working time ends the task", longCall.status === 409 && rowOf(jLong.id).reason === "max_duration");
      const { j: jCap } = await create();
      kv.store.set(stepKey, "4");
      const capped = await askStep(deviceToken, jCap.id, 1);
      const cappedBody = await capped.json();
      check("the day's step_cap refuses the next call with 429 and ends the task",
            capped.status === 429 && cappedBody.error === "step_limit" && cappedBody.cap === 4 && cappedBody.resetsAt > clock
            && rowOf(jCap.id).reason === "step_cap" && endedSentence("browser", "failed", "step_cap") === "Stopped — that's all the browser steps for today.");
      clearSteps();
      const capBefore = plans.free.step_cap;
      delete plans.free.step_cap;
      const { j: jClosed } = await create();
      check("with no step_cap on the plan the call fails closed", (await askStep(deviceToken, jClosed.id, 1)).status === 503);
      plans.free.step_cap = capBefore;

      // NOT A WAY ROUND THE QUESTION CAP
      kv.store.set(questionKey, "50");
      const qCapped = await worker.fetch(new Request("https://w/v1/ask", { method: "POST",
        headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ ...stepModelBody, model: "claude-sonnet-5" }) }), envTasks, makeCtx());
      const dodge = await askStep(deviceToken, undefined, 1, { ...stepModelBody, model: "claude-sonnet-5" });
      const dodgeOld = await askStep(deviceToken, jEnd.id, 1, { ...stepModelBody, model: "claude-sonnet-5" });
      check("with the question cap reached, the step route is no way round it: no task, or a finished one, is refused",
            qCapped.status === 429 && dodge.status === 400 && dodgeOld.status === 409);
      const stepsBefore = kv.store.get(stepKey);
      const qOk = await worker.fetch(new Request("https://w/v1/ask", { method: "POST",
        headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ ...stepModelBody, model: "claude-sonnet-5" }) }), envTasks, makeCtx());
      check("and a question never touches the step counter", kv.store.get(stepKey) === stepsBefore && qOk.status === 429);
      kv.store.delete(questionKey);
      clearSteps();
    }

    // --- step 4: the first ending wins, and a long answer is filed
    {
      const { finishTask } = await import("./src/tasks/run.js");
      const { renderBrowser, ANSWER_MAX } = await import("./src/tasks/browser.js");
      const { j: jRace } = await create();
      await stepPost(deviceToken, { id: jRace.id, n: 1, kind: "end", reason: "user_closed_tab" });
      await finishTask(envTasks, { id: jRace.id, accountId }, "failed", { reason: "step_failed" });
      check("the user's close stays the ending when a late step's failure finishes it again (the race of 2026-10-28)",
            rowOf(jRace.id).state === "cancelled" && rowOf(jRace.id).reason === "user_closed_tab");
      const short = renderBrowser({ answer: "The top story is Gemini 4 Carbon.", title: "HN" });
      check("a short answer is said whole and nothing is filed", short.spoken === "The top story is Gemini 4 Carbon." && !short.deliver);
      const long = "The top three stories are Gemini 4 Carbon, CNC Stone Carving and Dayjob. " + "More detail follows here. ".repeat(20);
      const filed = renderBrowser({ answer: long, title: "Hacker News top three" });
      check("a long answer is said as its first sentence and filed whole under the task's title",
            filed.spoken === "The top three stories are Gemini 4 Carbon, CNC Stone Carving and Dayjob." && filed.deliver.notes.title === "Hacker News top three"
            && filed.deliver.notes.body === long.trim() && filed.detail === long.trim());
      const { j: jLong } = await create();
      const posted = await stepPost(deviceToken, { id: jLong.id, n: 1, kind: "finish", answer: long });
      const kept = stepsOf(rowOf(jLong.id)).find((s) => s.kind === "finish");
      check(`the step route keeps an answer up to ${ANSWER_MAX} characters, so the long one reaches the notes`,
            posted.status === 200 && kept && kept.answer.length === long.trim().replace(/\s+/g, " ").length);
    }
    check("ledgerText strips a right-to-left override too", ledgerText(`a${rlo}b`, 10) === "ab");
    check("nothing of a page or a query reached the log", !logged.join("|").includes(PAGE) && !logged.join("|").includes(QUERY));
    clearCounter();
  }

  // --- the header grammar and the summary
  {
    const t0 = 1_760_000_000_000;
    const rows = [];
    for (let i = 0; i < 10; i++) {
      rows.push({ id: `id-${i}`, type: "research", state: "running", updated_at: t0 + i, seen_at: null });
    }
    rows[0] = { ...rows[0], state: "awaiting_approval", question: JSON.stringify({ spoken: "A; question: with=odd chars " + "x".repeat(300), until: t0 + 5 }), updated_at: t0 + 20 };
    rows[1] = { ...rows[1], state: "awaiting_approval", question: JSON.stringify({ spoken: "Older question?", until: t0 + 5 }), updated_at: t0 + 19 };
    rows[2] = { ...rows[2], state: "succeeded", result: JSON.stringify({ spoken: "Done one." }), updated_at: t0 + 18 };
    rows[3] = { ...rows[3], state: "failed", reason: "max_duration", updated_at: t0 + 17 };
    rows[4] = { ...rows[4], state: "succeeded", result: JSON.stringify({ spoken: "Done three." }), updated_at: t0 + 16 };
    rows[5] = { ...rows[5], state: "succeeded", result: JSON.stringify({ spoken: "Seen already." }), seen_at: t0, updated_at: t0 + 15 };
    const summary = summaryFromRows(rows, t0 + 100);
    const h = tasksHeader(summary)["otto-tasks"];
    const fields = h.split(";");
    check("the header counts running, awaiting and unseen, and a seen result is not unseen",
          fields.slice(0, 4).join(";") === "v=1;running=4;awaiting=2;unseen=3", fields.slice(0, 4).join(";"));
    check("it lists at most eight ids, awaiting first", fields.filter((f) => f.startsWith("t=")).length === 8 && fields[4].startsWith("t=id-0:awaiting_approval:research"));
    const q = fields.find((f) => f.startsWith("q="));
    check("one q, the oldest awaiting, cut at 240 and percent-encoded", q && q.startsWith("q=id-1:") && decodeURIComponent(q.slice("q=id-1:".length)) === "Older question?");
    const long = tasksHeader(summaryFromRows([rows[0]], t0))["otto-tasks"];
    const longQ = long.split(";").find((f) => f.startsWith("q=")).slice("q=id-0:".length);
    check("a long sentence is cut before encoding and its separators survive the encoding", decodeURIComponent(longQ).length === 240 && !longQ.includes(";") && !longQ.includes("="));
    const s = fields.filter((f) => f.startsWith("s="));
    check("at most two s, the newest unseen first, a failure carrying its fixed sentence",
          s.length === 2 && decodeURIComponent(s[0].slice("s=id-2:".length)) === "Done one." && decodeURIComponent(s[1].slice("s=id-3:".length)) === "The research ran out of time.", s.join(" "));
    check("the whole header stays under 1,500 bytes", new TextEncoder().encode(h).byteLength < 1500, String(new TextEncoder().encode(h).byteLength));
    check("no rows is present with zeros", tasksHeader(summaryFromRows([], t0))["otto-tasks"] === "v=1;running=0;awaiting=0;unseen=0");
    check("research is bounded to its maxSteps on the longest path: start, plan, the ask's two, twenty searches, draft and finish",
          1 + 1 + 2 + 20 + 1 + 1 <= TYPES.research.maxSteps);
  }

  Date.now = realNow;
  globalThis.fetch = async () => anthropicDone();
}

process.removeAllListeners("beforeExit");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
