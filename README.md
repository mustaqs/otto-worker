# otto-worker

Otto's relay to the Anthropic Messages API.

It exists so the API key is a **server-side secret** and never ships in the app.
Otto sends a per-user bearer token; the Worker validates it, checks that user's
limits, and forwards the request with the real key.

**This source is published deliberately.** Otto's privacy page claims the relay
does not store or log the contents of a request, and publishing the code is what
lets a sceptical person check rather than take it on trust. It is not proof:
published source is not proof of deployed source. It is better than a promise
and short of a guarantee, and Otto's privacy page says exactly that.

There is no secret in this repository. `ANTHROPIC_API_KEY` is set with
`wrangler secret put` and exists only in Cloudflare's environment.

## What it guarantees

**It streams.** `upstream.body` is handed to the `Response` untouched, so tokens
reach Otto as Anthropic emits them. Otto's whole latency story depends on this:
a 2s time-to-first-token becomes a 5s wait if the answer is assembled here
first, and speech cannot start early. `test.mjs` asserts it with a stalled
upstream, and that assertion is verified to fail — cleanly, not by hanging — on
an implementation that buffers.

**It counts requests, not tokens.** Counting output tokens would mean reading
the response body, which is the single most likely way to reintroduce
buffering. Counting requests means the Worker never touches a response at all,
so pass-through streaming holds by construction rather than by care.

The tradeoff, stated so nobody sets a cap while guessing: this bounds the
*number* of requests, not the cost of each. A request carries roughly a
1,450-token screenshot plus prompt — about **$0.007 of input at Opus rates**,
whether the answer is one line or ten. `MAX_OUTPUT_TOKENS` caps the other side.

**A leaked token is not a general-purpose Anthropic proxy.** Model must be in
the allowlist, `stream` must be true, `max_tokens` is capped, images are capped,
and the body has a size limit.

**Revocation is a flag, not a key rotation.** Set `active: false` on the token
record; the next request is refused. No redeploy, no effect on anyone else.

**It retains nothing.** No request or response content is read into a log, an
error body, or KV. The only things written are per-user counters.

**It tells you your own usage, without a second request.** Every response —
including a 429 refusal — carries an `otto-usage` header:

    otto-usage: day=12;day-cap=50;hour=3;hour-cap=10;day-resets=21600;hour-resets=1180

Every number was already read by `checkLimits` before the upstream call, so
this adds no KV read, no endpoint and no state. It rides on the response head,
which Workers emit as soon as the upstream headers arrive, so the app has the
numbers at time-to-first-token rather than at the end of the answer.

`day` and `hour` are **inclusive of the request being answered**. The counters
are read before the increment is scheduled, so reporting the raw read would
leave any display permanently one question behind.

The reset seconds exist because the counters roll over at UTC midnight and UTC
hour. A display saying "today" would be wrong for a third of the day for anyone
west of Greenwich; "resets in 6h" is true everywhere, and no timezone has to
exist anywhere in the system.

**Brace the variables in KV key commands.** The counter keys look like
`u:<token>:h:<YYYY-MM-DDTHH>`, and in zsh — macOS's default shell — `:h` is a
parameter expansion modifier meaning "head of path". So `"u:$TOKEN:h:$HOUR"`
expands `$TOKEN:h` to `.` and the command **silently reads, writes or deletes the
wrong key while appearing to succeed**. Always brace:

    TOKEN=beta-abc
    HOUR=$(date -u +%Y-%m-%dT%H)
    wrangler kv key put --remote --binding=OTTO "u:${TOKEN}:h:${HOUR}" 999
    wrangler kv key delete --remote --binding=OTTO "u:${TOKEN}:h:${HOUR}"

The daily key `u:${TOKEN}:d:${DAY}` is safe by luck — `:d` is not a modifier —
but brace it too rather than relying on which letters zsh happens to claim.

**Changes to KV are not visible for up to a minute.** Reads are edge-cached with
a `cacheTtl` default of 60 seconds, which is also the minimum settable value, so
there is no way to opt out. After any `wrangler kv key put`, wait ~65 seconds
before expecting the Worker to see it. The same applies to revoking a token or
lowering a cap.

The alternative was a `GET /v1/usage` endpoint the app would call when its
settings panel opened. That would make network activity no longer 1:1 with a
question the user asked — a new category of request, triggered by a UI gesture,
needing its own line in the privacy page. This costs less and explains better.

## Setup

    npm i -g wrangler
    wrangler login
    wrangler kv namespace create OTTO        # put the id in wrangler.toml
    wrangler secret put ANTHROPIC_API_KEY

`preview_urls` stays **false**. With it on, every deployed version gets its own
public URL — extra internet-facing surface on a Worker that holds a production
API key, for no benefit here. One address, one thing to reason about.

## Issuing a token

Token records are **versioned from the first day**, because retrofitting a
schema version onto records already in production means guessing at record
shape. A later version adding `plan`, `expiresAt` or `customerId` is then a
migration rather than archaeology.

    wrangler kv key put --remote --binding=OTTO "token:beta-alice-7f3a" \
      '{"v":1,"name":"alice","active":true,"dailyCap":200,"hourlyCap":40}'

**`--remote` is not optional, and leaving it off fails in the worst way.**
Without it wrangler writes to the local preview namespace, which the deployed
Worker cannot read — and `wrangler kv key get` reads that *same* local store, so
it cheerfully confirms a key that is not where it needs to be. The check agrees
with you while the Worker rejects the token, and the symptom looks like a bad
token rather than a key in the wrong namespace. Use `--remote` on every read and
write meant for production:

    wrangler kv key get --remote --binding=OTTO "token:beta-alice-7f3a"

Revoke — also `--remote`:

    wrangler kv key put --remote --binding=OTTO "token:beta-alice-7f3a" \
      '{"v":1,"name":"alice","active":false,"dailyCap":200,"hourlyCap":40}'

## Tests

    node test.mjs

No dependencies and no build step: it imports the Worker module and drives it
with a fake KV and a fake upstream.

## Deploy

    node test.mjs && wrangler deploy
