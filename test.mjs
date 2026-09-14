/**
 * Tests for the Otto relay.
 *
 * The streaming test is the reason this file exists. Every other property here
 * would fail loudly in use; buffering would not — it would just make Otto feel
 * slow, and the cause would be three layers away from the symptom.
 */
import worker from "./src/index.js";

let failures = 0;
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
        errors.some((e) => e.includes("deferred counter increment failed")), errors.join("|"));
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
          if (q.includes("FROM integrations WHERE connected_account_id")) return rows.find((r) => r.connected_account_id === args[0]) || null;
          return null;
        },
        all: async () => ({ results: q.includes("FROM integrations WHERE account_id") ? rows.filter((r) => r.account_id === args[0]) : [] }),
        run: async () => {
          if (q.startsWith("INSERT INTO integrations")) {
            const [account_id, app, connected_account_id, state, updated_at] = args;
            const existing = rows.find((r) => r.account_id === account_id && r.app === app);
            if (existing) Object.assign(existing, { connected_account_id, state, updated_at });
            else rows.push({ account_id, app, connected_account_id, state, updated_at });
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
                     COMPOSIO_AUTH_CONFIG_GMAIL: "ac_gmail", COMPOSIO_AUTH_CONFIG_GCAL: "ac_gcal", COMPOSIO_AUTH_CONFIG_SLACK: "ac_slack" };
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
    check("the reply carries every cloud app's state", r.headers.get("otto-integrations") === "gmail=none;gcal=none;slack=none");
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
    check("an unknown app is refused", (await post("/v1/integrations/link", deviceToken, { app: "notion" })).status === 400);

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
      messages: [{ sender: "alice@example.com", subject: "Lunch SECRETWORD", messageTimestamp: "2026-09-14T08:00:00Z", preview: "Are we still on?" }] } } }) };
    const r = await post("/v1/tool", deviceToken, { tool: "gmail_search", input: { query: "from:alice" }, now: "2026-09-14T09:00:00+05:30", tz: "Asia/Kolkata" });
    const j = await r.json();
    console.log = realLog; console.error = realError;
    check("a connected app's tool runs and answers ok", r.status === 200 && j.ok === true, JSON.stringify(j).slice(0, 120));
    check("the result is the compact shape, not Composio's", Array.isArray(j.result) && j.result[0].from === "alice@example.com" && j.result[0].subject.includes("Lunch") && !("messages" in j));
    const sent = calls.at(-1);
    check("Composio is asked under the account subject with the connected account and filled defaults",
          sent.body.user_id === accountId && sent.body.connected_account_id === "ca_test1234"
          && sent.body.arguments.query === "from:alice" && sent.body.arguments.max_results === 5 && sent.body.arguments.verbose === false);
    check("the reply carries the states, now with gmail active", r.headers.get("otto-integrations") === "gmail=active;gcal=none;slack=none");
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
    check("the reply's header already says expired", r.headers.get("otto-integrations") === "gmail=expired;gcal=none;slack=none");
    rows.find((r) => r.app === "gmail").state = "active";
    composioScript = { "POST /tools/execute/GMAIL_SEND_EMAIL": async () => ({ status: 200, json: { successful: false, error: "Recipient address rejected" } }) };
    const f = await post("/v1/tool", deviceToken, { tool: "gmail_send", input: { to: "bob@example.com", subject: "Hi", body: "Hello" }, now: "2026-09-14T09:00:00Z", tz: "UTC" });
    check("an ordinary failure is tool_failed and does not touch the row", f.status === 502 && (await f.json()).error === "tool_failed" && rows.find((r) => r.app === "gmail").state === "active");
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
    check("disconnect answers with the remaining states", r.status === 200 && r.headers.get("otto-integrations") === "gmail=none;gcal=none;slack=none");
    check("the authorization was deleted at Composio", calls.at(-1).method === "DELETE" && calls.at(-1).url.endsWith("/connected_accounts/ca_test1234"));
    check("and the row is gone", !rows.some((r) => r.app === "gmail"));
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
