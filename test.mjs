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
  const first = await worker.fetch(ask(valid), env(kv));
  const second = await worker.fetch(ask(valid), env(kv));
  const third = await worker.fetch(ask(valid), env(kv));
  check("under the hourly cap passes", first.status === 200 && second.status === 200);
  check("over the hourly cap is refused", third.status === 429);
  const body = await third.json();
  check("refusal names which limit and when to retry",
        body.error === "hourly_limit" && typeof body.retryAfter === "number");

  const daily = makeKV({ [`token:${goodToken}`]: account({ hourlyCap: 0, dailyCap: 1 }) });
  await worker.fetch(ask(valid), env(daily));
  check("daily cap is enforced separately",
        (await worker.fetch(ask(valid), env(daily))).status === 429);

  // Counted before the upstream call: a failure downstream must not be free.
  const counted = makeKV({ [`token:${goodToken}`]: account() });
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  await worker.fetch(ask(valid), env(counted));
  const day = new Date().toISOString().slice(0, 10);
  check("a failed upstream call still counts against the cap",
        counted.store.get(`u:${goodToken}:d:${day}`) === "1");
  globalThis.fetch = async () => new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
}

// ------------------------------------------------------------- validation

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
  await worker.fetch(ask({ ...valid,
    messages: [{ role: "user", content: [{ type: "text", text: secret }] }] }), env(kv));
  const stored = [...kv.store.entries()].map(([k, v]) => k + "=" + v).join("\n");
  check("no request content in anything written to KV", !stored.includes(secret));
  check("only counters and the token record were written",
        [...kv.store.keys()].every((k) => k.startsWith("u:") || k.startsWith("token:")));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
