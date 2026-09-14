/**
 * Otto's slim tools, mapped to Composio's actions (SPEC.md A76, decision 2).
 *
 * PURE FUNCTIONS, no bindings, no fetch: each maps one of Otto's ten tool
 * names and its arguments to one Composio action slug and its arguments, with
 * every parameter the user never said filled in here; and each compacts
 * Composio's reply to the few fields the model needs. Nothing here logs, and
 * nothing here is on the question path — Bench/check-tool-path.sh asserts
 * the file imports nothing and reads no `env`.
 *
 * The Composio schemas these fill were read from the API when the mapping was
 * designed; a field name that turns out to differ shows up as an empty compact
 * result, never as an error the user sees.
 */

/** The cloud tools by Otto's name. Mac tools never reach the Worker. */
export const CLOUD_TOOLS = {
  gmail_send:   { app: "gmail", slug: "GMAIL_SEND_EMAIL",             kind: "write" },
  gmail_search: { app: "gmail", slug: "GMAIL_FETCH_EMAILS",           kind: "read" },
  gcal_list:    { app: "gcal",  slug: "GOOGLECALENDAR_EVENTS_LIST",   kind: "read" },
  gcal_create:  { app: "gcal",  slug: "GOOGLECALENDAR_CREATE_EVENT",  kind: "create" },
  slack_post:   { app: "slack", slug: "SLACK_SEND_MESSAGE",           kind: "write" },
  slack_read:   { app: "slack", slug: "SLACK_SEARCH_MESSAGES",        kind: "read" },
  // Never listed to the model: Otto's own undo of a gcal_create, by the id
  // the create returned (A76, decision 3 as approved).
  gcal_delete:  { app: "gcal",  slug: "GOOGLECALENDAR_DELETE_EVENT",  kind: "delete" },
};

export const APPS = ["gmail", "gcal", "slack"];

const str = (v) => (typeof v === "string" ? v.trim() : "");
const int = (v, fallback) => (Number.isInteger(v) ? v : fallback);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const list = (v) => str(v).split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Composio's arguments for one of Otto's calls. `now` and `tz` come from the
 * app so defaults are computed in the user's day, not the Worker's.
 */
export function composioArguments(tool, input, now, tz) {
  const a = input && typeof input === "object" ? input : {};
  switch (tool) {
    case "gmail_send":
      return {
        recipient_email: str(a.to),
        subject: str(a.subject),
        body: str(a.body),
        cc: list(a.cc),
        is_html: false,
        user_id: "me",
      };
    case "gmail_search":
      return {
        query: str(a.query) || "in:inbox",
        max_results: clamp(int(a.max, 5), 1, 10),
        verbose: false,
        include_payload: false,
        ids_only: false,
        user_id: "me",
      };
    case "gcal_list":
      return {
        timeMin: str(a.from) || now,
        timeMax: str(a.to) || endOfDay(now, tz),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 20,
        calendarId: "primary",
      };
    case "gcal_create": {
      const minutes = clamp(int(a.minutes, 30), 1, 24 * 60 * 30);
      const attendees = list(a.attendees);
      const args = {
        summary: str(a.title),
        start_datetime: naive(str(a.start)),
        timezone: tz,
        event_duration_hour: Math.floor(minutes / 60),
        event_duration_minutes: minutes % 60,
        calendar_id: "primary",
      };
      if (attendees.length) { args.attendees = attendees; args.send_updates = "all"; }
      if (str(a.location)) args.location = str(a.location);
      return args;
    }
    case "slack_post":
      return {
        channel: str(a.channel).replace(/^#/, ""),
        markdown_text: str(a.text),
      };
    case "slack_read":
      return {
        query: `in:#${str(a.channel).replace(/^#/, "")}`,
        count: clamp(int(a.count, 20), 1, 50),
        sort: "timestamp",
        sort_dir: "desc",
      };
    case "gcal_delete":
      if (!str(a.id)) return null;
      return { event_id: str(a.id), calendar_id: "primary" };
    default:
      return null;
  }
}

/**
 * The few fields the model needs, from Composio's `data`. Read results are
 * arrays of small objects; writes say what happened and carry the id of the
 * thing made, for undo.
 */
export function compact(tool, data) {
  const d = data && typeof data === "object" ? data : {};
  switch (tool) {
    case "gmail_send":
      return { result: { sent: true }, id: null };
    case "gmail_search": {
      const messages = Array.isArray(d.messages) ? d.messages : [];
      return {
        result: messages.map((m) => ({
          from: firstOf(m, ["sender", "from"]),
          subject: firstOf(m, ["subject"]),
          date: firstOf(m, ["messageTimestamp", "date", "internalDate"]),
          snippet: firstOf(m, ["preview", "snippet", "messageText"]).slice(0, 200),
        })),
        id: null,
      };
    }
    case "gcal_list": {
      const items = Array.isArray(d.items) ? d.items : [];
      return {
        result: items.map((e) => ({
          title: firstOf(e, ["summary"]),
          start: when(e.start),
          end: when(e.end),
          location: firstOf(e, ["location"]),
          attendees: Array.isArray(e.attendees) ? e.attendees.length : 0,
        })),
        id: null,
      };
    }
    case "gcal_create":
      return { result: { created: true }, id: str(d.id) || str(d.event_id) || null };
    case "slack_post":
      return { result: { posted: true }, id: null };
    case "gcal_delete":
      return { result: { deleted: true }, id: null };
    case "slack_read": {
      const matches = d.messages && Array.isArray(d.messages.matches) ? d.messages.matches : [];
      return {
        result: matches.map((m) => ({
          from: firstOf(m, ["username", "user"]),
          time: tsToISO(m.ts),
          text: firstOf(m, ["text"]).slice(0, 500),
        })),
        id: null,
      };
    }
    default:
      return { result: {}, id: null };
  }
}

const firstOf = (o, keys) => {
  for (const k of keys) if (o && typeof o[k] === "string" && o[k]) return o[k];
  return "";
};
const when = (t) => (t && typeof t === "object" ? str(t.dateTime) || str(t.date) : "");
const tsToISO = (ts) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : "";
};

/** "2026-09-14T15:00:00+05:30" → "2026-09-14T15:00:00": the zone rides separately. */
export function naive(iso) {
  return iso.replace(/(\.\d+)?(Z|[+-]\d\d:?\d\d)$/, "");
}

/**
 * 23:59:59 at the end of the day `nowISO` falls on in `tz`, as RFC 3339 with
 * that zone's offset. Intl does the calendar; no library.
 */
export function endOfDay(nowISO, tz) {
  const now = new Date(nowISO);
  if (Number.isNaN(now.getTime())) return nowISO;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      timeZoneName: "longOffset",
    }).formatToParts(now);
  } catch {
    return nowISO;
  }
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
  const offsetName = get("timeZoneName");           // "GMT+05:30" or "GMT"
  const offset = offsetName === "GMT" ? "+00:00" : offsetName.replace("GMT", "");
  return `${get("year")}-${get("month")}-${get("day")}T23:59:59${offset}`;
}

/**
 * The `otto-integrations` header: one field per cloud app, `active`,
 * `expired`, `pending` or `none`. Mac apps never appear.
 */
export function integrationsHeader(rows) {
  const state = Object.fromEntries(APPS.map((app) => [app, "none"]));
  for (const row of rows || []) if (APPS.includes(row.app)) state[row.app] = row.state;
  return { "otto-integrations": APPS.map((app) => `${app}=${state[app]}`).join(";") };
}

/**
 * Whether a Composio execute reply means the authorization is gone. Composio's
 * `error` is free text; these are the shapes a lapsed Google or Slack token
 * produces. Anything else is a failed call, not a lost connection.
 */
export function looksLikeLostAuthorization(error) {
  const text = String(error || "").toLowerCase();
  return /\b401\b|unauthori[sz]ed|invalid_grant|token (has )?expired|expired|revoked|invalid_auth|not_authed|account_inactive/.test(text);
}

/**
 * Composio signs each webhook as HMAC-SHA256 over `${id}.${timestamp}.${body}`.
 * The signature header may carry several space-separated `v1,<base64>` entries
 * or one bare base64 value; any match verifies. The secret is used as UTF-8,
 * and if it carries a `whsec_` prefix its base64 remainder is tried too.
 * A timestamp outside `tolerance` seconds is refused whatever the signature.
 */
export async function verifyWebhookSignature({ id, timestamp, signature, body, secret, now = Date.now(), tolerance = 300 }) {
  if (!id || !timestamp || !signature || !secret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > tolerance) return false;

  const candidates = String(signature).split(/\s+/).map((s) => s.replace(/^v1,/, "")).filter(Boolean);
  const message = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  const secrets = [new TextEncoder().encode(secret)];
  if (secret.startsWith("whsec_")) {
    try { secrets.push(Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0))); } catch { /* not base64 */ }
  }
  for (const raw of secrets) {
    const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
    const expected = btoa(String.fromCharCode(...mac));
    for (const candidate of candidates) if (timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
