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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
