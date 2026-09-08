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
